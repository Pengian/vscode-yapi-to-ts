import * as vscode from 'vscode';
import { findDir } from '../../utils';
import path from 'path';
import fs from 'fs-extra';
import { dedent } from 'vtils';
import { command } from '../index';

import type { Uri } from 'vscode';

async function initConfigFile(file: Uri) {
  console.warn('pengian-----------------');
  try {
    // 获取激活指令的文件夹
    const dir = findDir(file.fsPath);
    const outputConfigFile = path.join(dir, './yapi', 'ytt.config.ts');

    await fs.outputFile(
      outputConfigFile,
      dedent`
          import { defineConfig } from 'yapi-to-typescript'
  
          export default defineConfig([
            {
              serverUrl: 'http://foo.bar',
              typesOnly: false,
              target: 'typescript',
              reactHooks: {
                enabled: false,
              },
              prodEnvName: 'production',
              outputFilePath: 'yapi/index.ts',
              requestFunctionFilePath: 'src/api/request.ts',
              dataKey: 'data',
              projects: [
                {
                  token: 'hello',
                  categories: [
                    {
                      id: 0,
                      getRequestFunctionName(interfaceInfo, changeCase) {
                        // 以接口全路径生成请求函数名
                        return changeCase.camelCase(interfaceInfo.path)
  
                        // 若生成的请求函数名存在语法关键词报错、或想通过某个关键词触发 IDE 自动引入提示，可考虑加前缀，如:
                        // return changeCase.camelCase(\`api_\${interfaceInfo.path}\`)
  
                        // 若生成的请求函数名有重复报错，可考虑将接口请求方式纳入生成条件，如:
                        // return changeCase.camelCase(\`\${interfaceInfo.method}_\${interfaceInfo.path}\`)
                      },
                    },
                  ],
                },
              ],
            },
          ])
        `
    );

    vscode.window.showInformationMessage('yapi配置文件已生成，请按项目需求配置！');
  } catch (error) {
    console.warn('error-------', error);
  }
}

const initConfig = vscode.commands.registerCommand('yapi-to-ts.initConfig', (file) => initConfigFile(file));

export default [initConfig];
