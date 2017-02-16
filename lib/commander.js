var util = require('util')
var path = require('path')
var fs = require('fs')
var events = require('events')
var assign = require('object-assign')
var Promise = require('bluebird')
var isAbsoluteUrl = require('is-absolute-url')
var requireDirectory = require('require-directory')
var homedir = require('os-homedir')
var yargs = require('yargs')
var prompt = require('prompt')
var createCommandParser = require('./createCommandParser')
var instanceHandler = require('./instanceHandler')

// commands that work without a jsreport entry point
var IGNORE_ENTRY_POINT_COMMANDS = [
  'init',
  'repair',
  'install',
  'uninstall',
  'render'
]

var BUILT_IN_COMMAND_MODULES = requireDirectory(
  module,
  path.join(__dirname, './commands'),
  {
    include: function (pathToCommand) {
      var isCommand = /\.js$/.test(path.basename(pathToCommand))
      var commandName = path.basename(pathToCommand, '.js')

      isCommand = commandName.indexOf('_') !== 0

      return isCommand
    }
  }
)

BUILT_IN_COMMAND_MODULES = Object.keys(BUILT_IN_COMMAND_MODULES).map(function (key) {
  return BUILT_IN_COMMAND_MODULES[key]
})

var ROOT_PATH = path.join(homedir(), '.jsreport')

if (!ROOT_PATH) {
  console.error('Couldn\'t detect the user home folder')
  process.exit(1)
}

var MAIN_SOCK_PATH = path.join(ROOT_PATH, 'sock')
var WORKER_SOCK_PATH = path.join(MAIN_SOCK_PATH, 'workerSock')

tryCreate(ROOT_PATH)
tryCreate(MAIN_SOCK_PATH)
tryCreate(WORKER_SOCK_PATH)

var Commander = module.exports = function Commander (cwd, options) {
  if (!(this instanceof Commander)) {
    return new Commander(cwd, options)
  }

  var self = this
  var opts = options || {}
  var cliHandler

  events.EventEmitter.call(self)

  self.cwd = cwd || process.cwd()
  self._commands = {}
  self._commandNames = []

  if (opts.builtInCommands) {
    self._builtInCommands = opts.builtInCommands
    self._ignoreEntryPointCommands = opts.ignoreEntryPointCommands || []
  } else {
    self._builtInCommands = BUILT_IN_COMMAND_MODULES
    self._ignoreEntryPointCommands = IGNORE_ENTRY_POINT_COMMANDS
  }

  self._builtInCommandNames = self._builtInCommands.map(function (cmdModule) { return cmdModule.command })

  // lazy initialization of cli handler, commands will be activated when
  // doing cliHandler.parse()
  if (opts.cli) {
    cliHandler = createCommandParser(options.cli)
  } else {
    cliHandler = (
      createCommandParser()
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
      // we are only declaring the "context" option to allow passing
      // a context object for other commands,
      // it is not mean to be used by users, that why it is hidden (description: false)
      // it needs to be global because we don't know if other command will be .strict() or not
      // and could cause validation errors
      .option('context', {
        alias: '_context_',
        description: false,
        global: true,
        type: 'string' // necessary to don't have any value if option is omitted
      })
      .strict()
    )
  }

  self._cli = cliHandler

  // registering built-in commands
  self._builtInCommands.forEach(function (commandModule) {
    self.registerCommand(commandModule)
  })

  self.emit('initialized')

  return this
}

util.inherits(Commander, events.EventEmitter)

Commander.prototype.start = function start (args) {
  var self = this
  var cwd = self.cwd
  var cliHandler = self._cli
  var ignoreEntryPointCommands = self._ignoreEntryPointCommands
  var builtInCommandNames = self._builtInCommandNames
  var userArgv
  var mainCommandReceived
  var commandShouldIgnoreEntryPoint
  var optionsForStart
  var versionRequired
  var helpRequired
  var needsPassword
  var verboseMode
  var log

  self.emit('starting')

  userArgv = yargs(args).argv

  versionRequired = userArgv.version || userArgv.v
  helpRequired = userArgv.help || userArgv.h
  needsPassword = userArgv.password || userArgv.p
  verboseMode = userArgv.verbose || userArgv.b
  log = createLog(verboseMode)

  if (userArgv._.length === 0) {
    self.emit('started', null, { handled: versionRequired || helpRequired, mainCommand: null })

    // activating CLI
    cliHandler.parse(args)

    // show help when no command was specified
    return cliHandler.showHelp()
  }

  if (userArgv._.length > 0) {
    mainCommandReceived = userArgv._.join('.')
  } else {
    mainCommandReceived = undefined
  }

  commandShouldIgnoreEntryPoint = (
    // if command is explicitly listed as something to ignore
    ignoreEntryPointCommands.indexOf(mainCommandReceived) !== -1 ||
    // if command is built-in and version or help options is activated
    (builtInCommandNames.indexOf(mainCommandReceived) !== 1 && (versionRequired || helpRequired))
  )

  optionsForStart = {
    cwd: cwd,
    ignoreEntryPoint: commandShouldIgnoreEntryPoint,
    log: log,
    verbose: verboseMode
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
      required: true
    }], function (err, result) {
      var errorToReject

      if (err) {
        errorToReject = new Error('No value for password option')

        self.emit('started', errorToReject, null)

        return printErrorAndExit()
      }

      // we need to add "coerce" function to "p/password" option to
      // allow set a predefined value
      cliHandler.option('p', {
        coerce: function () {
          return result.password
        }
      })

      handleCommand(self, args, optionsForStart, onBeforeCLIParse)
    })
  } else {
    handleCommand(self, args, optionsForStart, onBeforeCLIParse)
  }

  function onBeforeCLIParse (err) {
    var isSupportedCommand = self._commandNames.indexOf(mainCommandReceived) !== -1

    if (err) {
      return self.emit('started', err, null)
    }

    self.emit('started', null, {
      handled: isSupportedCommand || versionRequired || helpRequired,
      mainCommand: mainCommandReceived
    })
  }
}

Commander.prototype.executeCommand = function (commandName, argv) {
  var self = this
  var commandHandler = self._commands[commandName].handler

  if (!commandHandler) {
    throw new Error('"' + commandName + '" command is not a valid command')
  }

  return Promise.try(function () {
    self.emit('command.init', commandName, argv)
    self.emit(getCommandEventName(commandName, 'init'), argv)

    return commandHandler(argv)
  }).then(function (resolveValue) {
    self.emit('command.success', commandName, resolveValue)
    self.emit(getCommandEventName(commandName, 'success'), resolveValue)

    self.emit('command.finish', commandName)
    self.emit(getCommandEventName(commandName, 'finish'))
  }).catch(function (errorInCommand) {
    self.emit('command.error', commandName, errorInCommand)
    self.emit(getCommandEventName(commandName, 'error'), errorInCommand)

    self.emit('command.finish', commandName)
    self.emit(getCommandEventName(commandName, 'finish'))
  })
}

Commander.prototype.registerCommand = function registerCommand (commandModule) {
  var commandName = commandModule.command
  var self = this

  self._cli.command(assign({}, commandModule, {
    handler: self.executeCommand.bind(self, commandName)
  }))

  self._commands[commandName] = commandModule
  self._commandNames.push(commandName)

  self.emit('command.register', commandName, commandModule)

  return this
}

// check the command to see if we should handle jsreport instance
// initialization first or just delegate the command to cli handler
function handleCommand (commander, args, options, cb) {
  var log = options.log
  var ignoreEntryPoint = options.ignoreEntryPoint
  var cwd = options.cwd
  var verbose = options.verbose
  var context = {}

  context.cwd = cwd
  context.sockPath = MAIN_SOCK_PATH
  context.workerSockPath = WORKER_SOCK_PATH
  context.onError = printErrorAndExit

  if (ignoreEntryPoint) {
    // passing getInstance and initInstance as context
    // to commands when they should ignore the entry point
    context.getInstance = getInstance(log)
    context.initInstance = initInstance(verbose)

    cb()

    // delegating the command to the CLI and activating it
    return startCLI(log, commander, args, context)
  }

  getInstance(log, cwd)
  .then(function (instance) {
    return initInstance(verbose, instance)
  })
  .then(function (instance) {
    context.jsreport = instance

    cb()

    startCLI(log, commander, args, context)
  })
  .catch(function (err) {
    cb(err)

    printErrorAndExit(err)
  })
}

function startCLI (log, commander, args, context) {
  var cli = commander._cli

  // we need to add "coerce" function to "context" option to
  // don't allow override this value and preserve the real values
  cli.option('context', {
    coerce: function () {
      return context
    }
  })

  // activating CLI, resolving in next tick to avoid
  // showing errors of commands in catch handler
  process.nextTick(function () {
    try {
      cli.parse(args, { context: context })
    } catch (e) {
      var error = new Error('An unexpected error ocurred while trying to execute the command:')
      error.originalError = e
      printErrorAndExit(error)
    }
  })
}

function getInstance (log, cwd) {
  var args = Array.prototype.slice.call(arguments)

  if (args.length === 1) {
    return _getInstance_.bind(undefined, log)
  }

  return _getInstance_(log, cwd)

  function _getInstance_ (log, cwd) {
    return (
      instanceHandler
      .find(cwd)
      .then(function (instanceInfo) {
        if (instanceInfo.isDefault) {
          log(
            'no entry point was found, creating a default instance ' +
            'using: require("' + instanceInfo.from + '")()'
          )
        } else {
          log('using jsreport instance found in: ' + instanceInfo.entryPoint)
        }

        return instanceInfo.instance
      })
    )
  }
}

function initInstance (verbose, instance) {
  var args = Array.prototype.slice.call(arguments)

  if (args.length === 1) {
    return _initInstance_.bind(undefined, verbose)
  }

  return _initInstance_(verbose, instance)

  function _initInstance_ (verbose, instance) {
    return instanceHandler.initialize(instance, verbose)
  }
}

function getCommandEventName (command, event) {
  return 'command' + '.' + command + '.' + event
}

function tryCreate (dir) {
  try {
    fs.mkdirSync(dir, '0755')
  } catch (ex) { }
}

function printErrorAndExit (err) {
  console.error(err.message)

  if (err.originalError) {
    console.error(err.originalError)
  }

  process.exit(1)
}

function createLog (verboseMode) {
  if (verboseMode) {
    return function () {
      var args = Array.prototype.slice.call(arguments)
      console.log.apply(console, args)
    }
  }

  return function () {}
}