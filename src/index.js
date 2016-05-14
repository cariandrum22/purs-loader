'use strict'

const colors = require('chalk')
const debug = require('debug')('purs-loader')
const loaderUtils = require('loader-utils')
const globby = require('globby')
const Promise = require('bluebird')
const fs = Promise.promisifyAll(require('fs'))
const spawn = require('child_process').spawn
const path = require('path')
const retryPromise = require('promise-retry')

const psModuleRegex = /(?:^|\n)module\s+([\w\.]+)/i
const requireRegex = /require\(['"]\.\.\/([\w\.]+)['"]\)/g

module.exports = function purescriptLoader(source, map) {
  const callback = this.async()
  const config = this.options
  const query = loaderUtils.parseQuery(this.query)
  const webpackOptions = this.options.purescriptLoader || {}

  const options = Object.assign({
    context: config.context,
    psc: 'psc',
    pscArgs: {},
    pscBundle: 'psc-bundle',
    pscBundleArgs: {},
    pscIde: false,
    pscIdeColors: webpackOptions.psc === 'psa' || query.psc === 'psa',
    pscIdeArgs: {},
    bundleOutput: 'output/bundle.js',
    bundleNamespace: 'PS',
    bundle: false,
    warnings: true,
    output: 'output',
    src: [
      path.join('src', '**', '*.purs'),
      path.join('bower_components', 'purescript-*', 'src', '**', '*.purs')
    ],
    ffi: [
      path.join('src', '**', '*.js'),
      path.join('bower_components', 'purescript-*', 'src', '**', '*.js')
    ],
  }, webpackOptions, query)

  this.cacheable && this.cacheable()

  let cache = config.purescriptLoaderCache = config.purescriptLoaderCache || {
    rebuild: false,
    deferred: [],
    bundleModules: [],
  }

  if (!config.purescriptLoaderInstalled) {
    config.purescriptLoaderInstalled = true

    // invalidate loader cache when bundle is marked as invalid (in watch mode)
    this._compiler.plugin('invalid', () => {
      cache = config.purescriptLoaderCache = {
        rebuild: options.pscIde,
        deferred: [],
        ideServer: cache.ideServer
      }
    })

    // add psc warnings to webpack compilation warnings
    this._compiler.plugin('after-compile', (compilation, callback) => {
      if (options.warnings && cache.warnings) {
        compilation.warnings.unshift(`PureScript compilation:\n${cache.warnings}`)
      }

      if (cache.errors) {
        compilation.errors.unshift(`PureScript compilation:\n${cache.errors}`)
      }

      callback()
    })
  }

  const psModuleName = match(psModuleRegex, source)
  const psModule = {
    name: psModuleName,
    load: js => callback(null, js),
    reject: error => callback(error),
    srcPath: this.resourcePath,
    srcDir: path.dirname(this.resourcePath),
    jsPath: path.resolve(path.join(options.output, psModuleName, 'index.js')),
    options: options,
    cache: cache,
  }

  debug('loader called', psModule.name)

  if (options.bundle) {
    cache.bundleModules.push(psModule.name)
  }

  if (cache.rebuild) {
    return connectIdeServer(psModule)
      .then(rebuild)
      .then(toJavaScript)
      .then(psModule.load)
      .catch(psModule.reject)
  }

  if (cache.compilationFinished) {
    return toJavaScript(psModule).then(psModule.load).catch(psModule.reject)
  }

  // We need to wait for compilation to finish before the loaders run so that
  // references to compiled output are valid.
  cache.deferred.push(psModule)

  if (!cache.compilationStarted) {
    return compile(psModule)
      .then(() => Promise.map(cache.deferred, psModule => {
        if (typeof cache.ideServer === 'object') cache.ideServer.kill()
        return toJavaScript(psModule).then(psModule.load)
      }))
      .catch(error => {
        cache.deferred[0].reject(error)
        cache.deferred.slice(1).forEach(psModule => psModule.reject(true))
      })
  }
}

// The actual loader is executed *after* purescript compilation.
function toJavaScript(psModule) {
  const options = psModule.options
  const cache = psModule.cache
  const bundlePath = path.resolve(options.bundleOutput)
  const jsPath = cache.bundle ? bundlePath : psModule.jsPath

  debug('loading JavaScript for', psModule.name)

  return Promise.props({
    js: fs.readFileAsync(jsPath, 'utf8'),
    psModuleMap: psModuleMap(options.src, cache)
  }).then(result => {
    let js = ''

    if (options.bundle) {
      // if bundling, return a reference to the bundle
      js = 'module.exports = require("'
             + path.relative(psModule.srcDir, options.bundleOutput)
             + '")["' + psModule.name + '"]'
    } else {
      // replace require paths to output files generated by psc with paths
      // to purescript sources, which are then also run through this loader.
      const foreignRequire = 'require("' + path.resolve(
        path.join(psModule.options.output, psModule.name, 'foreign.js')
      ) + '")'

      js = result.js
        .replace(requireRegex, (m, p1) => {
          return 'require("' + result.psModuleMap[p1] + '")'
        })
        .replace(/require\(['"]\.\/foreign['"]\)/g, foreignRequire)
    }

    return js
  })
}

function compile(psModule) {
  const options = psModule.options
  const cache = psModule.cache
  const stderr = []

  if (cache.compilationStarted) return Promise.resolve(psModule)

  cache.compilationStarted = true

  const args = dargs(Object.assign({
    _: options.src,
    ffi: options.ffi,
    output: options.output,
  }, options.pscArgs))

  debug('spawning compiler %s %o', options.psc, args)

  return (new Promise((resolve, reject) => {
    console.log('\nCompiling PureScript...')

    const compilation = spawn(options.psc, args)

    compilation.stdout.on('data', data => stderr.push(data.toString()))
    compilation.stderr.on('data', data => stderr.push(data.toString()))

    compilation.on('close', code => {
      console.log('Finished compiling PureScript.')
      cache.compilationFinished = true
      if (code !== 0) {
        cache.errors = stderr.join('')
        reject(true)
      } else {
        cache.warnings = stderr.join('')
        resolve(psModule)
      }
    })
  }))
  .then(compilerOutput => {
    if (options.bundle) {
      return bundle(options, cache).then(() => psModule)
    }
    return psModule
  })
}

function rebuild(psModule) {
  const options = psModule.options
  const cache = psModule.cache

  debug('attempting rebuild with psc-ide-client %s', psModule.srcPath)

  const request = (body) => new Promise((resolve, reject) => {
    const args = dargs(options.pscIdeArgs)
    const ideClient = spawn('psc-ide-client', args)

    ideClient.stdout.once('data', data => {
      let res = null

      try {
        res = JSON.parse(data.toString())
        debug(res)
      } catch (err) {
        return reject(err)
      }

      if (res && !Array.isArray(res.result)) {
        return res.resultType === 'success'
               ? resolve(psModule)
               : reject('psc-ide rebuild failed')
      }

      Promise.map(res.result, (item, i) => {
        debug(item)
        return formatIdeResult(item, options, i, res.result.length)
      })
      .then(compileMessages => {
        if (res.resultType === 'error') {
          if (res.result.some(item => item.errorCode === 'UnknownModule')) {
            console.log('Unknown module, attempting full recompile')
            return compile(psModule)
              .then(() => request({ command: 'load' }))
              .then(resolve)
              .catch(() => reject('psc-ide rebuild failed'))
          }
          cache.errors = compileMessages.join('\n')
          reject('psc-ide rebuild failed')
        } else {
          cache.warnings = compileMessages.join('\n')
          resolve(psModule)
        }
      })
    })

    ideClient.stderr.once('data', data => reject(data.toString()))

    ideClient.stdin.write(JSON.stringify(body))
    ideClient.stdin.write('\n')
  })

  return request({
    command: 'rebuild',
    params: {
      file: psModule.srcPath,
    }
  })
}

function formatIdeResult(result, options, index, length) {
  const srcPath = path.relative(options.context, result.filename)
  const pos = result.position
  const fileAndPos = `${srcPath}:${pos.startLine}:${pos.startColumn}`
  let numAndErr = `[${index+1}/${length} ${result.errorCode}]`
  numAndErr = options.pscIdeColors ? colors.yellow(numAndErr) : numAndErr

  return fs.readFileAsync(result.filename, 'utf8').then(source => {
    const lines = source.split('\n').slice(pos.startLine - 1, pos.endLine)
    const endsOnNewline = pos.endColumn === 1 && pos.startLine !== pos.endLine
    const up = options.pscIdeColors ? colors.red('^') : '^'
    const down = options.pscIdeColors ? colors.red('v') : 'v'
    let trimmed = lines.slice(0)

    if (endsOnNewline) {
      lines.splice(lines.length - 1, 1)
      pos.endLine = pos.endLine - 1
      pos.endColumn = lines[lines.length - 1].length || 1
    }

    // strip newlines at the end
    if (endsOnNewline) {
      trimmed = lines.reverse().reduce((trimmed, line, i) => {
        if (i === 0 && line === '') trimmed.trimming = true
        if (!trimmed.trimming) trimmed.push(line)
        if (trimmed.trimming && line !== '') {
          trimmed.trimming = false
          trimmed.push(line)
        }
        return trimmed
      }, []).reverse()
      pos.endLine = pos.endLine - (lines.length - trimmed.length)
      pos.endColumn = trimmed[trimmed.length - 1].length || 1
    }

    const spaces = ' '.repeat(String(pos.endLine).length)
    let snippet = trimmed.map((line, i) => {
      return `  ${pos.startLine + i}  ${line}`
    }).join('\n')

    if (trimmed.length === 1) {
      snippet += `\n  ${spaces}  ${' '.repeat(pos.startColumn - 1)}${up.repeat(pos.endColumn - pos.startColumn + 1)}`
    } else {
      snippet = `  ${spaces}  ${' '.repeat(pos.startColumn - 1)}${down}\n${snippet}`
      snippet += `\n  ${spaces}  ${' '.repeat(pos.endColumn - 1)}${up}`
    }

    return Promise.resolve(
      `\n${numAndErr} ${fileAndPos}\n\n${snippet}\n\n${result.message}`
    )
  })
}

function bundle(options, cache) {
  if (cache.bundle) return Promise.resolve(cache.bundle)

  const stdout = []
  const stderr = cache.bundle = []

  const args = dargs(Object.assign({
    _: [path.join(options.output, '*', '*.js')],
    output: options.bundleOutput,
    namespace: options.bundleNamespace,
  }, options.pscBundleArgs))

  cache.bundleModules.forEach(name => args.push('--module', name))

  debug('spawning bundler %s %o', options.pscBundle, args.join(' '))

  return (new Promise((resolve, reject) => {
    console.log('Bundling PureScript...')

    const compilation = spawn(options.pscBundle, args)

    compilation.stdout.on('data', data => stdout.push(data.toString()))
    compilation.stderr.on('data', data => stderr.push(data.toString()))
    compilation.on('close', code => {
      if (code !== 0) {
        cache.errors = (cache.errors || '') + stderr.join('')
        return reject(true)
      }
      cache.bundle = stderr
      resolve(fs.appendFileAsync('output/bundle.js', `module.exports = ${options.bundleNamespace}`))
    })
  }))
}

// map of PS module names to their source path
function psModuleMap(globs, cache) {
  if (cache.psModuleMap) return Promise.resolve(cache.psModuleMap)

  return globby(globs).then(paths => {
    return Promise
      .props(paths.reduce((map, file) => {
        map[file] = fs.readFileAsync(file, 'utf8')
        return map
      }, {}))
      .then(srcMap => {
        cache.psModuleMap = Object.keys(srcMap).reduce((map, file) => {
          const source = srcMap[file]
          const psModuleName = match(psModuleRegex, source)
          map[psModuleName] = path.resolve(file)
          return map
        }, {})
        return cache.psModuleMap
      })
  })
}

function connectIdeServer(psModule) {
  const options = psModule.options
  const cache = psModule.cache

  if (cache.ideServer) return Promise.resolve(psModule)

  cache.ideServer = true

  const connect = () => new Promise((resolve, reject) => {
    const args = dargs(options.pscIdeArgs)

    debug('attempting to connect to psc-ide-server', args)

    const ideClient = spawn('psc-ide-client', args)

    ideClient.stderr.on('data', data => {
      debug(data.toString())
      cache.ideServer = false
      reject(true)
    })
    ideClient.stdout.once('data', data => {
      debug(data.toString())
      if (data.toString()[0] === '{') {
        const res = JSON.parse(data.toString())
        if (res.resultType === 'success') {
          cache.ideServer = ideServer
          resolve(psModule)
        } else {
          cache.ideServer = ideServer
          reject(true)
        }
      } else {
        cache.ideServer = false
        reject(true)
      }
    })
    ideClient.stdin.resume()
    ideClient.stdin.write(JSON.stringify({ command: 'load' }))
    ideClient.stdin.write('\n')
  })

  const args = dargs(Object.assign({
    outputDirectory: options.output,
  }, options.pscIdeArgs))

  debug('attempting to start psc-ide-server', args)

  const ideServer = cache.ideServer = spawn('psc-ide-server', [])
  ideServer.stderr.on('data', data => {
    debug(data.toString())
  })

  return retryPromise((retry, number) => {
    return connect().catch(error => {
      if (!cache.ideServer && number === 9) {
        debug(error)

        console.log(
          'failed to connect to or start psc-ide-server, ' +
          'full compilation will occur on rebuild'
        )

        return Promise.resolve(psModule)
      }

      return retry(error)
    })
  }, {
    retries: 9,
    factor: 1,
    minTimeout: 333,
    maxTimeout: 333,
  })
}

function match(regex, str) {
  const matches = str.match(regex)
  return matches && matches[1]
}

function dargs(obj) {
  return Object.keys(obj).reduce((args, key) => {
    const arg = '--' + key.replace(/[A-Z]/g, '-$&').toLowerCase();
    const val = obj[key]

    if (key === '_') val.forEach(v => args.push(v))
    else if (Array.isArray(val)) val.forEach(v => args.push(arg, v))
    else args.push(arg, obj[key])

    return args.filter(arg => (typeof arg !== 'boolean'))
  }, [])
}
