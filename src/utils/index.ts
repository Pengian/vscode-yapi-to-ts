import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

/**
 * 是否有package.json文件
 * @param dirPath 目录路径
 * @returns {boolean}
 */
function hasPackageJson(dirPath: string) {
  const packageJson = path.join(dirPath, 'package.json');
  return fs.existsSync(packageJson);
}

export function getProjectPath() {
  if (!vscode?.workspace?.workspaceFolders) {
    vscode.window.showInformationMessage('未打开项目目录，请先打开目录！');
    return;
  }
  let workspaceFolders = vscode.workspace.workspaceFolders.map((item) => item.uri.path);
  // 由于存在Multi-root工作区，暂时没有特别好的判断方法，先这样粗暴判断
  // 如果发现只有一个根文件夹，读取其子文件夹作为 workspaceFolders
  if (workspaceFolders.length == 1) {
    return workspaceFolders[0];
  }
  workspaceFolders.forEach((folder) => {});
}

/**
 * @description 返回文件夹/文件路径
 * @param {string} filePath
 * @return {*}  {string}
 */
export function findDir(filePath: string): string {
  if (fs.statSync(filePath).isFile()) {
    return path.dirname(filePath);
  }
  return filePath;
}
