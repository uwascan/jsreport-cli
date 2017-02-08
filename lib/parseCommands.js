var path = require('path')
var fs = require('fs')
var isPromise = require('is-promise')
var isAbsoluteUrl = require('is-absolute-url')
var once = require('once')
var yargs = require('yargs')
var prompt = require('prompt')
var packageJson = require('../package.json')

module.exports = function parseCommands (args) {
  var builtInCommands = []

  // commands that work without a jsreport entry point
  var commandsToIgnoreEntryPoint = [
    'init',
    'repair',
    'install',
    'uninstall'
  ]

  var userArgv = yargs(args).argv
  var needsPassword = userArgv.password || userArgv.p
  var verboseMode = userArgv.verbose || userArgv.b
  var userPkg
  var cliArgv
  var mainCommandReceived
  var commandShouldIgnoreEntryPoint
  var existsPackageJson
  var pathToJsreportEntryPoint
  var jsreportModuleInfo
  var jsreportEntryPoint
  var jsreportEntryPointExport

  // lazy initialization of cli handler, commands will be activated when
  // doing cliHandler.parse()
  var cliHandler = yargs
      .version('v', undefined, packageJson.version)
      .usage('Usage: $0 [options] <command> [options]')
      .commandDir('commands', {
        include: function (pathToCommand) {
          var isCommand = /\.js$/.test(path.basename(pathToCommand))
          var commandName = path.basename(pathToCommand, '.js')

          isCommand = commandName.indexOf('_') !== 0

          // adding built-in commands to our array
          if (isCommand) {
            builtInCommands.push(commandName)
          }

          return isCommand
        }
      })
      .showHelpOnFail(false)
      .help('h', false)
      .alias('v', 'version')
      .alias('h', 'help')
      .option('b', {
        alias: 'verbose',
        description: 'Enables verbose mode',
        type: 'boolean',
        global: true
      })
      .option('s', {
        alias: 'serverUrl',
        description: 'Specifies a url to a remote jsreport server, that server will be the target of the command (only if command support this mode)',
        type: 'string',
        requiresArg: true,
        global: true,
        coerce: function (value) {
          if (!isAbsoluteUrl(value)) {
            throw new Error('serverUrl option must be a valid absolute url')
          }

          return value
        }
      })
      .option('u', {
        alias: 'user',
        description: 'Specifies a username for authentication against a jsreport server (Use if some command needs authentication information)',
        type: 'string',
        requiresArg: true,
        global: true
      })
      .option('p', {
        alias: 'password',
        description: 'Specifies a password for authentication against a jsreport server (Use if some command needs authentication information)',
        global: true
      })
      // we are only declaring the "jsreport" option to allow passing
      // the jsreport instance as context for other commands,
      // it is not mean to be used by users, that why it is hidden (description: false)
      // it needs to be global because we don't know if other command will be .strict() or not
      // and could cause validation errors
      .option('jsreport', {
        alias: '_jsreport_',
        description: false,
        global: true,
        type: 'string', // necessary to don't have any value if option is omitted
        coerce: function (value) {
          // a little hack to always have "true" if for some reason the user
          // tries to use this hidden option
          return true
        }
      })
      .epilog('To show more information about a command, type: $0 <command> -h')
      .strict()

  if (userArgv._.length === 0) {
    // activating CLI
    cliArgv = cliHandler.parse(args)

    // show help when no command was specified
    if (cliArgv._.length === 0) {
      return cliHandler.showHelp()
    }
  }

  if (needsPassword) {
    prompt.start()

    prompt.message = ''

    return prompt.get([{
      name: 'password',
      description: 'Password',
      message: 'Password can\'t be empty',
      type: 'string',
      hidden: true,
      replace: '*',
      required: true
    }], function (err, result) {
      if (err) {
        console.error('No value for password')
        return process.exit(1)
      }

      // delegating the command to the CLI and activating it, we need to
      // add "coerce" function to "p/password" option to allow set a predefined value
      return cliHandler.option('p', {
        coerce: function () {
          return result.password
        }
      }).parse(args)
    })
  }

  // if user has provied a command,
  // check if we should handle jsreport instance initialization first or just
  // delegate the command to cli handler
  mainCommandReceived = userArgv._[0]

  commandShouldIgnoreEntryPoint = (
    commandsToIgnoreEntryPoint.indexOf(mainCommandReceived) !== -1 ||
    // if command is built-in and serverUrl option is activated start CLI without entry point
    (builtInCommands.indexOf(mainCommandReceived) !== 1 && (userArgv.serverUrl || userArgv.s))
  )

  if (commandShouldIgnoreEntryPoint) {
    // delegating the command to the CLI and activating it
    return cliHandler.parse(args)
  }

  // finding entry point before activating CLI
  existsPackageJson = fs.existsSync('package.json')
  jsreportModuleInfo = getJsreportModuleInstalled(existsPackageJson)

  if (!jsreportModuleInfo) {
    console.log('Couldn\'t find a jsreport intallation necessary to process the command, try to install jsreport first')
    return process.exit(1)
  }

  if (!existsPackageJson) {
    // creating a default instance
    return handleJsreportInstance(createDefaultInstance(
      jsreportModuleInfo.name,
      jsreportModuleInfo.module,
      verboseMode
    ))
  }

  userPkg = require(path.join(process.cwd(), './package.json'))
  jsreportEntryPoint = (userPkg.jsreport || {}).entryPoint

  if (!jsreportEntryPoint) {
    // creating a default instance
    return handleJsreportInstance(createDefaultInstance(
      jsreportModuleInfo.name,
      jsreportModuleInfo.module,
      verboseMode
    ))
  }

  try {
    var entryPointExportResult
    var resolveInstanceOnce
    var duplicateResolutionHandler

    pathToJsreportEntryPoint = path.resolve(process.cwd(), jsreportEntryPoint)
    jsreportEntryPointExport = require(pathToJsreportEntryPoint)

    if (typeof jsreportEntryPointExport === 'function') {
      resolveInstanceOnce = once(resolveInstance)
      entryPointExportResult = jsreportEntryPointExport(resolveInstanceOnce)

      // prevents resolving an instance more than once
      duplicateResolutionHandler = function () {
        console.log(
          'jsreport instance is already resolved, are you using promise and callback at the same time? ' +
          'you should only use one way to resolve the instance from entry point, check file in ' +
          pathToJsreportEntryPoint
        )

        return process.exit(1)
      }

      // check if function returns a promise, otherwise just wait until user calls `resolveInstanceOnce`
      if (isPromise(entryPointExportResult)) {
        if (resolveInstanceOnce.called) {
          return duplicateResolutionHandler()
        }

        entryPointExportResult.then(function (jsreportInstance) {
          if (resolveInstanceOnce.called) {
            return duplicateResolutionHandler()
          }

          if (!isJsreportInstance(jsreportInstance, jsreportModuleInfo.module)) {
            console.log(
              'Promise in entry point must resolve to a jsreport instance, check file in ' +
              pathToJsreportEntryPoint
            )

            return process.exit(1)
          }

          resolveInstanceOnce(null, jsreportInstance)
        }).catch(function (getJsreportInstanceError) {
          if (resolveInstanceOnce.called) {
            return duplicateResolutionHandler()
          }

          resolveInstanceOnce(getJsreportInstanceError)
        })
      }
    } else if (isJsreportInstance(jsreportEntryPointExport, jsreportModuleInfo.module)) {
      log('using jsreport instance found in: ' + pathToJsreportEntryPoint)

      handleJsreportInstance(jsreportEntryPointExport)
    } else {
      console.log(
        'Entry point must return a valid jsreport instance or a function resolving to a jsreport instance, check file in ' +
        pathToJsreportEntryPoint
      )

      process.exit(1)
    }
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') {
      console.log('Couldn\'t find a jsreport entry point in:', pathToJsreportEntryPoint)
      return process.exit(1)
    }

    console.log('An error has occurred when trying to find a jsreport instance..')
    console.error(e)
    process.exit(1)
  }

  function handleJsreportInstance (instance) {
    if (!instance._initialized) {
      // explicitly silent jsreport logging if verboseMode is not activated
      if (!verboseMode) {
        if (instance.options.logger) {
          instance.options.logger.silent = true
        } else {
          instance.options.logger = {
            silent: true
          }
        }
      }

      // initializing jsreport instance
      instance.init().then(function () {
        activateCLIAfterInit(instance)
      }).catch(function (err) {
        // error during startup
        console.error('An error has occurred when trying to initialize jsreport..')

        if (err.code === 'EADDRINUSE') {
          console.error('seems like there is already a server running in port:', err.port)
        }

        console.error(err)
        process.exit(1)
      })
    } else {
      activateCLIAfterInit(instance)
    }
  }

  function activateCLIAfterInit (instance) {
    // activating CLI passing the jsreport instance, resolving in next tick to avoid
    // showing errors of commands in catch handler
    process.nextTick(function () {
      cliHandler.parse(args, { jsreport: instance })
    })
  }

  function resolveInstance (err, instance) {
    if (err) {
      console.log('An error has occurred when trying to find a jsreport instance..')
      console.error(err)
      return process.exit(1)
    }

    log('using jsreport instance resolved from function found in: ' + pathToJsreportEntryPoint)

    handleJsreportInstance(instance)
  }

  function createDefaultInstance (jsreportModuleName, jsreportModuleExport, verboseMode) {
    log(
      'no entry point was found, creating a default instance ' +
      'using: require("' + jsreportModuleName + '")()'
    )

    return jsreportModuleExport()
  }

  function log (msg, force) {
    if (force === true) {
      return console.log(msg)
    }

    if (verboseMode) {
      return console.log(msg)
    }
  }
}

function isJsreportInstance (instance, jsreportModule) {
  if (!instance) {
    return false
  }

  return instance instanceof jsreportModule.Reporter
}

function getJsreportModuleInstalled (existsPackageJson) {
  var detectedJsreport
  var detectedModule
  var userPkg
  var userDependencies

  if (existsPackageJson) {
    userPkg = require(path.join(process.cwd(), './package.json'))
    userDependencies = userPkg.dependencies || {}

    if (userDependencies['jsreport']) {
      detectedJsreport = 'jsreport'
    } else if (userDependencies['jsreport-core']) {
      detectedJsreport = 'jsreport-core'
    }
  }

  if (!detectedJsreport) {
    if (fs.existsSync(path.join(process.cwd(), 'node_modules/jsreport'))) {
      detectedJsreport = 'jsreport'
    } else if (fs.existsSync(path.join(process.cwd(), 'node_modules/jsreport-core'))) {
      detectedJsreport = 'jsreport-core'
    }
  }

  if (!detectedJsreport) {
    return null
  }

  try {
    // always require top-level package from cwd
    detectedModule = require(require.resolve(path.join(process.cwd(), 'node_modules', detectedJsreport)))

    detectedModule = {
      name: detectedJsreport,
      module: detectedModule
    }
  } catch (err) {
    detectedModule = null
  }

  return detectedModule
}