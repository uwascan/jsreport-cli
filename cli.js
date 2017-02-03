#!/usr/bin/env node

var path = require('path')
var fs = require('fs')
var packageJson = require('./package.json')
var yargs = require('yargs')
var args = process.argv.slice(2)

// commands that work without a jsreport entry point
var commandsToIgnoreEntryPoint = [
  'init',
  'repair',
  'install',
  'uninstall'
]

var userArgv = yargs(args).argv
var verboseMode = userArgv.verbose || userArgv.b
var userPkg
var cliArgv
var mainCommandReceived
var commandShouldIgnoreEntryPoint
var existsPackageJson
var pathToJsreportEntryPoint
var jsreportModuleInfo
var jsreportEntryPoint
var jsreportInstance

// lazy initialization of cli handler, commands will be activated when
// doing cliHandler.parse()
var cliHandler = yargs
    .version('v', undefined, packageJson.version)
    .usage('Usage: $0 [options] <command> [options]')
    .commandDir('lib/commands', {
      exclude: function (pathToCommand) {
        return /^_/.exec(path.basename(pathToCommand))
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

// if user has provied a command,
// check if we should handle jsreport instance initialization first or just
// delegate the command to cli handler
mainCommandReceived = userArgv._[0]

commandShouldIgnoreEntryPoint = (
  commandsToIgnoreEntryPoint.indexOf(mainCommandReceived) !== -1
)

if (commandShouldIgnoreEntryPoint) {
  // delegating the command to the CLI and activating it
  return cliHandler.parse(args)
}

// finding entry point before activating CLI
existsPackageJson = fs.existsSync('package.json')
jsreportModuleInfo = getJsreportModuleInstalled(existsPackageJson)

if (!jsreportModuleInfo) {
  return console.log('Couldn\'t find a jsreport intallation necessary to process the command, try to install jsreport first')
}

if (!existsPackageJson) {
  // creating a default instance
  jsreportInstance = createDefaultInstance(
    jsreportModuleInfo.name,
    jsreportModuleInfo.module,
    verboseMode
  )
} else {
  userPkg = require(path.join(process.cwd(), './package.json'))
  jsreportEntryPoint = (userPkg.jsreport || {}).entryPoint

  if (!jsreportEntryPoint) {
    // creating a default instance
    jsreportInstance = createDefaultInstance(
      jsreportModuleInfo.name,
      jsreportModuleInfo.module,
      verboseMode
    )
  } else {
    try {
      pathToJsreportEntryPoint = path.resolve(process.cwd(), jsreportEntryPoint)
      jsreportInstance = require(pathToJsreportEntryPoint)

      if (!isJsreportInstance(jsreportInstance, jsreportModuleInfo.module)) {
        console.log(
          'Entry point doesn\'t returns a valid jsreport instance, check file in ' +
          pathToJsreportEntryPoint
        )

        return
      }

      log('using jsreport instance found in: ' + pathToJsreportEntryPoint)
    } catch (e) {
      if (e.code === 'MODULE_NOT_FOUND') {
        console.log('Couldn\'t find a jsreport entry point in:', pathToJsreportEntryPoint)
        return
      }

      console.log('An error has occurred when trying to find a jsreport instance..')
      console.error(e)
      return
    }
  }
}

if (!jsreportInstance._initialized) {
  // initializing jsreport instance
  jsreportInstance.init().then(function () {
    activateCLIAfterInit(jsreportInstance)
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
  activateCLIAfterInit(jsreportInstance)
}

function activateCLIAfterInit (jsreportInstance) {
  // activating CLI passing the jsreport instance, resolving in next tick to avoid
  // showing errors of commands in catch handler
  process.nextTick(function () {
    cliHandler.parse(args, { jsreport: jsreportInstance })
  })
}

function log (msg, force) {
  if (force === true) {
    return console.log(msg)
  }

  if (verboseMode) {
    return console.log(msg)
  }
}

function createDefaultInstance (jsreportModuleName, jsreportModuleExport, verboseMode) {
  log(
    'no entry point was found, creating a default instance ' +
    'using: require("' + jsreportModuleName + '")()'
  )

  if (jsreportModuleName === 'jsreport' && !verboseMode) {
    // disable logging when using the jsreport package if verbose mode is not activated
    return jsreportModuleExport({ logger: { providerName: 'dummy' } })
  }

  return jsreportModuleExport()
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
    detectedModule = require(require.resolve(detectedJsreport))

    detectedModule = {
      name: detectedJsreport,
      module: detectedModule
    }
  } catch (err) {
    if (err.code !== 'MODULE_NOT_FOUND') {
      detectedModule = null
    } else {
      // trying to read from top level node_modules, only necessary
      // when CLI is being tested locally using `npm link`
      try {
        detectedModule = require(path.join(process.cwd(), 'node_modules/' + detectedJsreport))

        detectedModule = {
          name: detectedJsreport,
          module: detectedModule
        }
      } catch (e) {
        detectedModule = null
      }
    }
  }

  return detectedModule
}
