// The module 'vscode' contains the VS Code extensibility API
import initConfig from './initConfig';

/**
 * 指令枚举
 */
export enum command {
  /**
   * 指令：初始化配置文件
   */
  init = 'yapi-to-ts.initConfig',
}

export default [initConfig];
