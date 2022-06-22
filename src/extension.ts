import * as vscode from 'vscode';
// import command from './command';
import initConfig from './command/initConfig';

console.warn('初始化---------------');

export function activate(context: vscode.ExtensionContext) {
  console.warn('active--------------------------');
  context.subscriptions.push(...initConfig);
}

// this method is called when your extension is deactivated
export function deactivate() {}
