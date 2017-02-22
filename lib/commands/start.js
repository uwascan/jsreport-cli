'use strict'

var description = 'Starts a jsreport process in current working directory'
var command = 'start'

exports.command = command
exports.description = description

exports.builder = function (yargs) {
  return (
    yargs
    .usage(description + '\nUsage: $0 ' + command)
    .check(function (argv, hash) {
      if (argv.serverUrl) {
        throw new Error('serverUrl option is not supported in this command')
      }

      return true
    })
  )
}

exports.handler = function (argv) {
  var verbose = argv.verbose
  var context = argv.context
  var cwd = context.cwd
  var getInstance = context.getInstance
  var initInstance = context.initInstance
  var disableProcessExit = context.disableProcessExit

  if (disableProcessExit) {
    // this command is designed to start a long-running process,
    // so the process should not exit after the execution
    disableProcessExit()
  }

  if (verbose) {
    console.log('resolving jsreport location..')
  }

  return (
    getInstance(cwd)
    .then(function (jsreportInstance) {
      if (verbose) {
        console.log('starting jsreport..')
      }

      // init and resolving the promise with the instance
      return initInstance(jsreportInstance, true)
    }).then(function (result) {
      if (verbose) {
        console.log('jsreport successfully started')
      }

      return result
    })
  )
}