import * as vscode from 'vscode';
import command from './command';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(...command);
}
