import * as vscode from 'vscode'
import semver from 'semver'
import { effect } from '@vue/reactivity'
import { extensionId, getConfig } from './config'
import { TestFileDiscoverer } from './discover'
import { isVitestEnv } from './pure/isVitestEnv'
import { getVitestCommand, getVitestVersion, isNodeAvailable, stringToCmd } from './pure/utils'
import { debugHandler, runHandler, updateSnapshot } from './runHandler'
import { TestFile, WEAKMAP_TEST_DATA } from './TestData'
import { TestWatcher } from './watch'
import { Command } from './command'
import { StatusBarItem } from './StatusBarItem'

const log = vscode.window.createOutputChannel('Vitest')
export async function activate(context: vscode.ExtensionContext) {
  if (
    vscode.workspace.workspaceFolders == null
    || vscode.workspace.workspaceFolders.length === 0
  )
    return

  if (
    !getConfig().enable
    && !(await isVitestEnv(vscode.workspace.workspaceFolders[0].uri.fsPath))
  )
    return

  const ctrl = vscode.tests.createTestController(`${extensionId}`, 'Vitest')

  const fileDiscoverer = new TestFileDiscoverer()
  // run on refreshing test list
  ctrl.refreshHandler = async () => {
    await fileDiscoverer.discoverAllTestFilesInWorkspace(ctrl)
  }

  ctrl.resolveHandler = async (item) => {
    if (!item) {
      // item == null, when user opened the testing panel
      // in this case, we should discover and watch all the testing files
      context.subscriptions.push(
        ...(await fileDiscoverer.watchAllTestFilesInWorkspace(ctrl)),
      )
    }
    else {
      const data = WEAKMAP_TEST_DATA.get(item)
      if (data instanceof TestFile)
        await data.updateFromDisk(ctrl)
    }
  }

  const vitestCmd = getVitestCommand(
    vscode.workspace.workspaceFolders[0].uri.fsPath,
  ) ?? {
    cmd: 'npx',
    args: ['vitest'],
  }

  const vitestVersion = await getVitestVersion(vitestCmd, getConfig().env || undefined).catch(async (e) => {
    log.appendLine(e.toString())
    log.appendLine(`process.env.PATH = ${process.env.PATH}`)
    log.appendLine(`vitest.nodeEnv = ${JSON.stringify(getConfig().env)}`)
    let errorMsg = e.toString()
    if (!isNodeAvailable(getConfig().env || undefined)) {
      log.appendLine('Cannot spawn node process')
      errorMsg += 'Cannot spawn node process. Please try setting vitest.nodeEnv as {"PATH": "/path/to/node"} in your settings.'
    }

    vscode.window.showErrorMessage(errorMsg)
  })

  console.dir({ vitestVersion })

  const customTestCmd = getConfig().commandLine
  if ((vitestVersion && semver.gte(vitestVersion, '0.8.0')) || customTestCmd) {
    // enable run/debug/watch tests only if vitest version >= 0.8.0
    const testWatcher: undefined | TestWatcher = registerWatchHandler(
      vitestCmd ?? stringToCmd(customTestCmd!),
      ctrl,
      fileDiscoverer,
      context,
    )
    registerRunHandler(ctrl, testWatcher)
    context.subscriptions.push(
      vscode.commands.registerCommand(Command.UpdateSnapshot, (test) => {
        updateSnapshot(ctrl, test)
      }),
    )
  }
  else {
    const msg = 'Because Vitest version < 0.8.0, run/debug/watch tests from Vitest extension disabled.\n'
    context.subscriptions.push(
      vscode.commands.registerCommand(Command.ToggleWatching, () => {
        vscode.window.showWarningMessage(msg)
      }),
      vscode.commands.registerCommand(Command.UpdateSnapshot, () => {
        vscode.window.showWarningMessage(msg)
      }),
    )
    // v0.8.0 introduce a breaking change in json format
    // https://github.com/vitest-dev/vitest/pull/1034
    // so we need to disable run & debug in version < 0.8.0
    vscode.window.showWarningMessage(msg)
  }

  vscode.window.visibleTextEditors.forEach(x =>
    fileDiscoverer.discoverTestFromDoc(ctrl, x.document),
  )

  context.subscriptions.push(
    ctrl,
    // TODO
    // vscode.commands.registerCommand("vitest-explorer.configureTest", () => {
    //   vscode.window.showInformationMessage("Not implemented");
    // }),
    fileDiscoverer,
    vscode.workspace.onDidOpenTextDocument((e) => {
      fileDiscoverer.discoverTestFromDoc(ctrl, e)
    }),
    vscode.workspace.onDidChangeTextDocument(e =>
      fileDiscoverer.discoverTestFromDoc(ctrl, e.document),
    ),
  )
}

let statusBarItem: StatusBarItem
function registerWatchHandler(
  vitestCmd: { cmd: string; args: string[] } | undefined,
  ctrl: vscode.TestController,
  fileDiscoverer: TestFileDiscoverer,
  context: vscode.ExtensionContext,
) {
  if (!vitestCmd)
    return

  const testWatcher = TestWatcher.create(ctrl, fileDiscoverer, vitestCmd)
  statusBarItem = new StatusBarItem()
  effect(() => {
    if (testWatcher.isRunning.value) {
      statusBarItem.toRunningMode()
      return
    }

    if (testWatcher.isWatching.value) {
      statusBarItem.toWatchMode(testWatcher.testStatus.value)
      return
    }

    statusBarItem.toDefaultMode()
  })

  const stopWatching = () => {
    testWatcher!.dispose()
    vscode.workspace
      .getConfiguration('testing')
      .update('automaticallyOpenPeekView', undefined)
  }
  const startWatching = () => {
    testWatcher!.watch()
    vscode.workspace
      .getConfiguration('testing')
      .update('automaticallyOpenPeekView', 'never')
  }

  context.subscriptions.push(
    {
      dispose: stopWatching,
    },
    testWatcher,
    statusBarItem,
    vscode.commands.registerCommand(Command.StartWatching, startWatching),
    vscode.commands.registerCommand(Command.StopWatching, stopWatching),
    vscode.commands.registerCommand(Command.ToggleWatching, () => {
      if (testWatcher.isWatching.value)
        stopWatching()
      else
        startWatching()
    }),
  )

  ctrl.createRunProfile(
    'Run Tests (Watch Mode)',
    vscode.TestRunProfileKind.Run,
    runHandler,
    false,
  )

  async function runHandler(
    request: vscode.TestRunRequest,
    _cancellation: vscode.CancellationToken,
  ) {
    if (
      vscode.workspace.workspaceFolders === undefined
      || vscode.workspace.workspaceFolders.length === 0
    )
      return

    await testWatcher.watch()
    testWatcher.runTests(request.include)
  }

  return testWatcher
}

function registerRunHandler(
  ctrl: vscode.TestController,
  testWatcher?: TestWatcher,
) {
  ctrl.createRunProfile(
    'Run Tests',
    vscode.TestRunProfileKind.Run,
    runHandler.bind(null, ctrl, testWatcher),
    true,
  )

  ctrl.createRunProfile(
    'Debug Tests',
    vscode.TestRunProfileKind.Debug,
    debugHandler.bind(null, ctrl),
    true,
  )
}

export function deactivate() {}
