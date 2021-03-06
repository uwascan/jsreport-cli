const path = require('path')
const fs = require('fs')
const childProcess = require('child_process')
const should = require('should')
const stdMocks = require('std-mocks')
const jsreportVersionToTest = require('../jsreportVersionToTest')
const utils = require('../utils')
const commander = require('../../lib/commander')
const exitMock = utils.mockProcessExit

describe('commander', () => {
  describe('when using jsreport instances', () => {
    let pathToTempProject

    const originalPkgJson = {
      name: 'commander-project',
      dependencies: {
        jsreport: jsreportVersionToTest
      }
    }

    before(function (done) {
      // disabling timeout because npm install could take a
      // couple of seconds
      this.timeout(0)

      utils.cleanTempDir(['commander-project'])

      utils.createTempDir(['commander-project'], (dir, absoluteDir) => {
        pathToTempProject = absoluteDir

        fs.writeFileSync(
          path.join(absoluteDir, './package.json'),
          JSON.stringify(originalPkgJson, null, 2)
        )

        fs.writeFileSync(
          path.join(absoluteDir, './server.js'),
          [
            'const jsreport = require("jsreport")()',
            'if (process.env.JSREPORT_CLI) {',
            'module.exports = jsreport',
            '} else {',
            'jsreport.init().catch(function (e) {',
            'console.error("error on jsreport init")',
            'console.error(e.stack)',
            'process.exit(1)',
            '})',
            '}'
          ].join('\n')
        )
      })

      console.log('installing dependencies for test suite...')

      childProcess.exec('npm install', {
        cwd: pathToTempProject
      }, (error, stdout, stderr) => {
        if (error) {
          console.log('error while installing dependencies for test suite...')
          return done(error)
        }

        console.log('installation of dependencies for test suite completed...')
        done()
      })
    })

    beforeEach(() => {
      // deleting cache of package.json to allow run the tests on the same project
      delete require.cache[require.resolve(path.join(pathToTempProject, './package.json'))]

      fs.writeFileSync(
        path.join(pathToTempProject, './package.json'),
        JSON.stringify(originalPkgJson, null, 2)
      )
    })

    it('should emit event on instance searching', (done) => {
      const cli = commander(pathToTempProject)
      let instanceLookupCalled = false
      let instanceFoundCalled = false
      let instanceInEvent
      let instanceInHandler

      const testCommand = {
        command: 'test',
        description: 'test command desc',
        handler: (argv) => {
          instanceInHandler = argv.context.jsreport
          return instanceInHandler
        }
      }

      cli.registerCommand(testCommand)

      cli.on('instance.lookup', () => (instanceLookupCalled = true))

      cli.on('instance.found', (instance) => {
        instanceFoundCalled = true
        instanceInEvent = instance
      })

      cli.on('command.success', (cmdName, result) => {
        setTimeout(() => {
          let exitCode

          stdMocks.restore()
          stdMocks.flush()
          exitMock.restore()

          exitCode = exitMock.callInfo().exitCode

          should(cmdName).be.eql('test')
          should(exitCode).be.eql(0)
          should(instanceLookupCalled).be.eql(true)
          should(instanceFoundCalled).be.eql(true)
          should(instanceInHandler).be.exactly(instanceInEvent)
          should(result).be.exactly(instanceInHandler)

          instanceInHandler.express.server.close()

          done()
        }, 200)
      })

      stdMocks.use()
      exitMock.enable()

      // set entry point in package.json of test project
      fs.writeFileSync(
        path.join(pathToTempProject, './package.json'),
        JSON.stringify(
          Object.assign({
            jsreport: {
              entryPoint: 'server.js'
            }
          }, originalPkgJson),
          null, 2
        )
      )

      cli.start(['test'])
    })

    it('should emit event when using a default instance', function (done) {
      const cli = commander(pathToTempProject)
      let instanceLookupCalled = false
      let instanceDefaultCalled = false
      let instanceInEvent
      let instanceInHandler

      const testCommand = {
        command: 'test',
        description: 'test command desc',
        handler: (argv) => {
          instanceInHandler = argv.context.jsreport
          return instanceInHandler
        }
      }

      cli.registerCommand(testCommand)

      cli.on('instance.lookup', () => (instanceLookupCalled = true))

      cli.on('instance.default', (instance) => {
        instanceDefaultCalled = true
        instanceInEvent = instance
      })

      cli.on('command.success', (cmdName, result) => {
        setTimeout(() => {
          let exitCode

          stdMocks.restore()
          stdMocks.flush()
          exitMock.restore()

          exitCode = exitMock.callInfo().exitCode

          should(cmdName).be.eql('test')
          should(exitCode).be.eql(0)
          should(instanceLookupCalled).be.eql(true)
          should(instanceDefaultCalled).be.eql(true)
          should(instanceInHandler).be.exactly(instanceInEvent)
          should(result).be.exactly(instanceInHandler)

          instanceInHandler.express.server.close()

          done()
        }, 200)
      })

      stdMocks.use()
      exitMock.enable()

      cli.start(['test'])
    })

    it('should emit event on instance initialization', (done) => {
      const cli = commander(pathToTempProject)
      let instanceInitializingCalled = false
      let instanceInHandler

      const testCommand = {
        command: 'test',
        description: 'test command desc',
        handler: (argv) => {
          instanceInHandler = argv.context.jsreport
          return instanceInHandler
        }
      }

      cli.registerCommand(testCommand)

      cli.on('instance.initializing', () => (instanceInitializingCalled = true))

      cli.on('instance.initialized', (result) => {
        setTimeout(() => {
          let exitCode

          stdMocks.restore()
          stdMocks.flush()
          exitMock.restore()

          exitCode = exitMock.callInfo().exitCode

          should(exitCode).be.eql(0)
          should(instanceInitializingCalled).be.eql(true)
          should(result).be.exactly(instanceInHandler)

          instanceInHandler.express.server.close()

          done()
        }, 200)
      })

      stdMocks.use()
      exitMock.enable()

      cli.start(['test'])
    })

    after(function () {
      // disabling timeout because removing files could take a
      // couple of seconds
      this.timeout(0)

      utils.cleanTempDir(['commander-project'])
    })
  })
})
