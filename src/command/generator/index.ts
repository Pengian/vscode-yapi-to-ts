import * as changeCase from 'change-case';
import dayjs from 'dayjs';
import fs from 'fs-extra';
import got from 'got';
import path from 'path';
import { castArray, cloneDeepFast, dedent, groupBy, isEmpty, isFunction, last, memoize, noop, omit, uniq, values } from 'vtils';
import {
  CategoryList,
  CommentConfig,
  ExtendedInterface,
  Interface,
  InterfaceList,
  Method,
  Project,
  ProjectConfig,
  QueryStringArrayFormat,
  RequestBodyType,
  ServerConfig,
  SyntheticalConfig,
  ChangeCase,
} from '../../types';
import { exec } from 'child_process';
import { getRequestDataJsonSchema, getResponseDataJsonSchema, jsonSchemaToType, sortByWeights, throwError } from '../../utils';
import * as vscode from 'vscode';

import type { Uri } from 'vscode';
interface OutputFileList {
  [outputFilePath: string]: {
    syntheticalConfig: SyntheticalConfig;
    content: string[];
  };
}
// @ts-ignore
const changeCase1: ChangeCase = changeCase;

/**
 * @see https://webpack.js.org/guides/tree-shaking/#mark-a-function-call-as-side-effect-free
 * @see https://terser.org/docs/api-reference.html#annotations
 */
const COMPRESSOR_TREE_SHAKING_ANNOTATION = '/*#__PURE__*/';

export class Generator {
  /** 配置 */
  private config: ServerConfig[] = [];
  private url = '';
  private token = '';
  private storagePath = path.resolve(__dirname, './storage.txt');
  private options: { cwd: string } = { cwd: '' };

  private disposes: Array<() => any> = [];

  constructor() {}

  /**
   * 准备yapi请求域名及项目token
   * @returns Promise
   */
  async prepare(uri: Uri): Promise<void> {
    const workspaceUri = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0].uri;
    const currentUri = uri || workspaceUri;
    if (!currentUri) {
      vscode.window.showErrorMessage('未打开工作区目录！');
      return Promise.reject('未打开工作区目录！');
    }
    this.options.cwd = currentUri.fsPath;
    const res = await vscode.window.showInputBox({
      title: '部署域名/token',
      placeHolder: '请输入yapi部署域名或项目token',
      prompt: '自动识别域名/token，域名请携带http协议头',
    });
    if (!res) return Promise.reject();
    const urlRegExp = /^https?:\/\/[\w\-/_.]{5,}$/;
    const tokenRegExp = /^\w{64}$/;
    if (urlRegExp.test(res)) {
      this.url = res.replace(/\/+$/, '');
      fs.writeFile(this.storagePath, this.url);
      const token = await vscode.window.showInputBox({
        title: '项目token',
        placeHolder: '请输入项目token',
        prompt: '项目token从项目-设置-token配置中获取',
      });
      if (!token) return Promise.reject();
      if (tokenRegExp.test(token)) {
        this.token = token;
        return Promise.resolve();
      }
      vscode.window.showErrorMessage('请输入正确的项目token');
      return Promise.reject('请输入正确的项目token');
    } else if (tokenRegExp.test(res)) {
      this.token = res;
      this.url = fs.readFileSync(this.storagePath, 'utf8');
      if (!this.url) {
        const url = await vscode.window.showInputBox({
          title: '部署域名',
          placeHolder: '请输入部署完整的域名',
        });
        if (!url) return Promise.reject();
        if (urlRegExp.test(url)) {
          this.url = url.replace(/\/+$/, '');
          fs.writeFile(this.storagePath, this.url);
          return Promise.resolve();
        }
        vscode.window.showErrorMessage('请输入有效的部署域名');
        return Promise.reject('请输入有效的部署域名');
      }
    } else {
      vscode.window.showErrorMessage('请输入有效的部署域名/token');
      return Promise.reject(new Error('请输入有效的部署域名/token'));
    }
    return Promise.resolve();
  }

  setConfig() {
    this.config = [
      {
        serverUrl: this.url,
        typesOnly: true,
        target: 'typescript',
        reactHooks: {
          enabled: false,
        },
        prodEnvName: 'production',
        outputFilePath: 'yapi/index.ts',
        dataKey: 'data',
        projects: [
          {
            token: this.token,
            categories: [
              {
                id: 0,
              },
            ],
          },
        ],
      },
    ];
  }

  async generate(): Promise<OutputFileList> {
    const outputFileList: OutputFileList = Object.create(null);

    await Promise.all(
      this.config.map(async (serverConfig, serverIndex) => {
        const projects = serverConfig.projects.reduce<ProjectConfig[]>((projects, project) => {
          projects.push(
            ...castArray(project.token).map((token) => ({
              ...project,
              token: token,
            }))
          );
          return projects;
        }, []);
        return Promise.all(
          projects.map(async (projectConfig, projectIndex) => {
            const projectInfo = await this.fetchProjectInfo({
              ...serverConfig,
              ...projectConfig,
            });
            await Promise.all(
              projectConfig.categories.map(async (categoryConfig, categoryIndex) => {
                // 分类处理
                // 数组化
                let categoryIds = castArray(categoryConfig.id);
                // 全部分类
                if (categoryIds.includes(0)) {
                  categoryIds.push(...projectInfo.cats.map((cat) => cat._id));
                }
                // 唯一化
                categoryIds = uniq(categoryIds);
                // 去掉被排除的分类
                const excludedCategoryIds = categoryIds.filter((id) => id < 0).map(Math.abs);
                categoryIds = categoryIds.filter((id) => !excludedCategoryIds.includes(Math.abs(id)));
                // 删除不存在的分类
                categoryIds = categoryIds.filter((id) => !!projectInfo.cats.find((cat) => cat._id === id));
                // 顺序化
                categoryIds = categoryIds.sort();

                const codes = (
                  await Promise.all(
                    categoryIds.map<
                      Promise<
                        Array<{
                          outputFilePath: string;
                          code: string;
                          weights: number[];
                        }>
                      >
                    >(async (id, categoryIndex2) => {
                      categoryConfig = {
                        ...categoryConfig,
                        id: id,
                      };
                      const syntheticalConfig: SyntheticalConfig = {
                        ...serverConfig,
                        ...projectConfig,
                        ...categoryConfig,
                        mockUrl: projectInfo.getMockUrl(),
                      };
                      syntheticalConfig.target = syntheticalConfig.target || 'typescript';
                      syntheticalConfig.devUrl = projectInfo.getDevUrl(syntheticalConfig.devEnvName!);
                      syntheticalConfig.prodUrl = projectInfo.getProdUrl(syntheticalConfig.prodEnvName!);

                      // 接口列表
                      let interfaceList = await this.fetchInterfaceList(syntheticalConfig);
                      interfaceList = interfaceList
                        .map((interfaceInfo) => {
                          // 实现 _project 字段
                          interfaceInfo._project = omit(projectInfo, ['cats', 'getMockUrl', 'getDevUrl', 'getProdUrl']);
                          // 预处理
                          const _interfaceInfo = isFunction(syntheticalConfig.preproccessInterface)
                            ? syntheticalConfig.preproccessInterface(cloneDeepFast(interfaceInfo), changeCase1, syntheticalConfig)
                            : interfaceInfo;

                          return _interfaceInfo;
                        })
                        .filter(Boolean) as any;
                      interfaceList.sort((a, b) => a._id - b._id);

                      const interfaceCodes = await Promise.all(
                        interfaceList.map<
                          Promise<{
                            categoryUID: string;
                            outputFilePath: string;
                            weights: number[];
                            code: string;
                          }>
                        >(async (interfaceInfo) => {
                          const outputFilePath = path.resolve(
                            this.options.cwd,
                            typeof syntheticalConfig.outputFilePath === 'function'
                              ? syntheticalConfig.outputFilePath(interfaceInfo, changeCase1)
                              : syntheticalConfig.outputFilePath!
                          );
                          const categoryUID = `_${serverIndex}_${projectIndex}_${categoryIndex}_${categoryIndex2}`;
                          const code = await this.generateInterfaceCode(syntheticalConfig, interfaceInfo, categoryUID);
                          const weights: number[] = [serverIndex, projectIndex, categoryIndex, categoryIndex2];
                          return {
                            categoryUID,
                            outputFilePath,
                            weights,
                            code,
                          };
                        })
                      );

                      const groupedInterfaceCodes = groupBy(interfaceCodes, (item) => item.outputFilePath);
                      return Object.keys(groupedInterfaceCodes).map((outputFilePath) => {
                        const categoryCode = [
                          ...uniq(sortByWeights(groupedInterfaceCodes[outputFilePath]).map((item) => item.categoryUID)).map((categoryUID) =>
                            syntheticalConfig.typesOnly
                              ? ''
                              : dedent`
                                      const mockUrl${categoryUID} = ${JSON.stringify(syntheticalConfig.mockUrl)} as any
                                      const devUrl${categoryUID} = ${JSON.stringify(syntheticalConfig.devUrl)} as any
                                      const prodUrl${categoryUID} = ${JSON.stringify(syntheticalConfig.prodUrl)} as any
                                      const dataKey${categoryUID} = ${JSON.stringify(syntheticalConfig.dataKey)} as any
                                    `
                          ),
                          ...sortByWeights(groupedInterfaceCodes[outputFilePath]).map((item) => item.code),
                        ]
                          .filter(Boolean)
                          .join('\n\n');
                        if (!outputFileList[outputFilePath]) {
                          outputFileList[outputFilePath] = {
                            syntheticalConfig,
                            content: [],
                          };
                        }
                        return {
                          outputFilePath: outputFilePath,
                          code: categoryCode,
                          weights: last(sortByWeights(groupedInterfaceCodes[outputFilePath]))!.weights,
                        };
                      });
                    })
                  )
                ).flat();

                for (const groupedCodes of values(groupBy(codes, (item) => item.outputFilePath))) {
                  sortByWeights(groupedCodes);
                  outputFileList[groupedCodes[0].outputFilePath].content.push(...groupedCodes.map((item) => item.code));
                }
              })
            );
          })
        );
      })
    );

    return outputFileList;
  }

  async write(outputFileList: OutputFileList) {
    return Promise.all(
      Object.keys(outputFileList).map(async (outputFilePath) => {
        let {
          // eslint-disable-next-line prefer-const
          content,
          // eslint-disable-next-line prefer-const
          syntheticalConfig,
        } = outputFileList[outputFilePath];

        if (syntheticalConfig.target === 'javascript') {
          await this.tsc(outputFilePath);
          await Promise.all([fs.remove(outputFilePath).catch(noop)]);
        }
      })
    );
  }

  async tsc(file: string) {
    return new Promise<void>((resolve) => {
      // add this to fix bug that not-generator-file-on-window
      const command = `${require('os').platform() === 'win32' ? 'node ' : ''}${JSON.stringify(require.resolve(`typescript/bin/tsc`))}`;

      exec(
        `${command} --target ES2019 --module ESNext --jsx preserve --declaration --esModuleInterop ${JSON.stringify(file)}`,
        {
          cwd: this.options.cwd,
          env: process.env,
        },
        () => resolve()
      );
    });
  }

  async fetchApi<T = any>(url: string, query: Record<string, any>): Promise<T> {
    const { body: res } = await got.get<{
      errcode: any;
      errmsg: any;
      data: any;
    }>(url, {
      searchParams: query,
      responseType: 'json',
      https: {
        rejectUnauthorized: false,
      },
    });
    /* istanbul ignore next */
    if (res && res.errcode) {
      throwError(res.errmsg);
    }
    return res.data || res;
  }

  fetchProject = memoize(
    async ({ serverUrl, token }: SyntheticalConfig) => {
      const projectInfo = await this.fetchApi<Project>(`${serverUrl}/api/project/get`, {
        token: token!,
      });
      const basePath = `/${projectInfo.basepath || '/'}`.replace(/\/+$/, '').replace(/^\/+/, '/');
      projectInfo.basepath = basePath;
      // 实现项目在 YApi 上的地址
      projectInfo._url = `${serverUrl}/project/${projectInfo._id}/interface/api`;
      return projectInfo;
    },
    ({ serverUrl, token }: SyntheticalConfig) => `${serverUrl}|${token}`
  );

  fetchExport = memoize(
    async ({ serverUrl, token }: SyntheticalConfig) => {
      const projectInfo = await this.fetchProject({ serverUrl, token });
      const categoryList = await this.fetchApi<CategoryList>(`${serverUrl}/api/plugin/export`, {
        type: 'json',
        status: 'all',
        isWiki: 'false',
        token: token!,
      });
      return categoryList.map((cat) => {
        const projectId = cat.list?.[0]?.project_id || 0;
        const catId = cat.list?.[0]?.catid || 0;
        // 实现分类在 YApi 上的地址
        cat._url = `${serverUrl}/project/${projectId}/interface/api/cat_${catId}`;
        cat.list = (cat.list || []).map((item) => {
          const interfaceId = item._id;
          // 实现接口在 YApi 上的地址
          item._url = `${serverUrl}/project/${projectId}/interface/api/${interfaceId}`;
          item.path = `${projectInfo.basepath}${item.path}`;
          return item;
        });
        return cat;
      });
    },
    ({ serverUrl, token }: SyntheticalConfig) => `${serverUrl}|${token}`
  );

  /** 获取分类的接口列表 */
  async fetchInterfaceList({ serverUrl, token, id }: SyntheticalConfig): Promise<InterfaceList> {
    const category = ((await this.fetchExport({ serverUrl, token })) || []).find(
      (cat) => !isEmpty(cat) && !isEmpty(cat.list) && cat.list[0].catid === id
    );

    if (category) {
      category.list.forEach((interfaceInfo) => {
        // 实现 _category 字段
        interfaceInfo._category = omit(category, ['list']);
      });
    }

    return category ? category.list : [];
  }

  /** 获取项目信息 */
  async fetchProjectInfo(syntheticalConfig: SyntheticalConfig) {
    const projectInfo = await this.fetchProject(syntheticalConfig);
    const projectCats = await this.fetchApi<CategoryList>(`${syntheticalConfig.serverUrl}/api/interface/getCatMenu`, {
      token: syntheticalConfig.token!,
      project_id: projectInfo._id,
    });
    return {
      ...projectInfo,
      cats: projectCats,
      getMockUrl: () => `${syntheticalConfig.serverUrl}/mock/${projectInfo._id}`,
      getDevUrl: (devEnvName: string) => {
        const env = projectInfo.env.find((e) => e.name === devEnvName);
        return (env && env.domain) /* istanbul ignore next */ || '';
      },
      getProdUrl: (prodEnvName: string) => {
        const env = projectInfo.env.find((e) => e.name === prodEnvName);
        return (env && env.domain) /* istanbul ignore next */ || '';
      },
    };
  }

  /** 生成接口代码 */
  async generateInterfaceCode(syntheticalConfig: SyntheticalConfig, interfaceInfo: Interface, categoryUID: string) {
    const extendedInterfaceInfo: ExtendedInterface = {
      ...interfaceInfo,
      parsedPath: path.parse(interfaceInfo.path),
    };
    const requestFunctionName = isFunction(syntheticalConfig.getRequestFunctionName)
      ? await syntheticalConfig.getRequestFunctionName(extendedInterfaceInfo, changeCase1)
      : changeCase1.camelCase(extendedInterfaceInfo.parsedPath.name);
    const requestConfigName = changeCase1.camelCase(`${requestFunctionName}RequestConfig`);
    const requestConfigTypeName = changeCase1.pascalCase(requestConfigName);
    const requestDataTypeName = isFunction(syntheticalConfig.getRequestDataTypeName)
      ? await syntheticalConfig.getRequestDataTypeName(extendedInterfaceInfo, changeCase1)
      : changeCase1.pascalCase(`${requestFunctionName}Request`);
    const responseDataTypeName = isFunction(syntheticalConfig.getResponseDataTypeName)
      ? await syntheticalConfig.getResponseDataTypeName(extendedInterfaceInfo, changeCase1)
      : changeCase1.pascalCase(`${requestFunctionName}Response`);
    const requestDataJsonSchema = getRequestDataJsonSchema(extendedInterfaceInfo, syntheticalConfig.customTypeMapping || {});
    const requestDataType = await jsonSchemaToType(requestDataJsonSchema, requestDataTypeName);
    const responseDataJsonSchema = getResponseDataJsonSchema(
      extendedInterfaceInfo,
      syntheticalConfig.customTypeMapping || {},
      syntheticalConfig.dataKey
    );
    const responseDataType = await jsonSchemaToType(responseDataJsonSchema, responseDataTypeName);
    const isRequestDataOptional = /(\{\}|any)$/s.test(requestDataType);
    const requestHookName =
      syntheticalConfig.reactHooks && syntheticalConfig.reactHooks.enabled
        ? isFunction(syntheticalConfig.reactHooks.getRequestHookName)
          ? /* istanbul ignore next */
            await syntheticalConfig.reactHooks.getRequestHookName(extendedInterfaceInfo, changeCase1)
          : `use${changeCase1.pascalCase(requestFunctionName)}`
        : '';

    // 支持路径参数
    const paramNames = (extendedInterfaceInfo.req_params /* istanbul ignore next */ || []).map((item) => item.name);
    const paramNamesLiteral = JSON.stringify(paramNames);
    const paramNameType = paramNames.length === 0 ? 'string' : `'${paramNames.join("' | '")}'`;

    // 支持查询参数
    const queryNames = (extendedInterfaceInfo.req_query /* istanbul ignore next */ || []).map((item) => item.name);
    const queryNamesLiteral = JSON.stringify(queryNames);
    const queryNameType = queryNames.length === 0 ? 'string' : `'${queryNames.join("' | '")}'`;

    // 接口注释
    const genComment = (genTitle: (title: string) => string) => {
      const {
        enabled: isEnabled = true,
        title: hasTitle = true,
        category: hasCategory = true,
        tag: hasTag = true,
        requestHeader: hasRequestHeader = true,
        updateTime: hasUpdateTime = true,
        link: hasLink = true,
        extraTags,
      } = {
        ...syntheticalConfig.comment,
        // Swagger 时总是禁用标签、更新时间、链接
        ...(syntheticalConfig.serverType === 'swagger'
          ? {
              tag: false,
              updateTime: false,
              link: false,
            }
          : {}),
      } as CommentConfig;
      if (!isEnabled) {
        return '';
      }
      // 转义标题中的 /
      const escapedTitle = String(extendedInterfaceInfo.title).replace(/\//g, '\\/');
      const description = hasLink ? `[${escapedTitle}↗](${extendedInterfaceInfo._url})` : escapedTitle;
      const summary: Array<
        | false
        | {
            label: string;
            value: string | string[];
          }
      > = [
        hasCategory && {
          label: '分类',
          value: hasLink
            ? `[${extendedInterfaceInfo._category.name}↗](${extendedInterfaceInfo._category._url})`
            : extendedInterfaceInfo._category.name,
        },
        hasTag && {
          label: '标签',
          value: extendedInterfaceInfo.tag.map((tag) => `\`${tag}\``),
        },
        hasRequestHeader && {
          label: '请求头',
          value: `\`${extendedInterfaceInfo.method.toUpperCase()} ${extendedInterfaceInfo.path}\``,
        },
        hasUpdateTime && {
          label: '更新时间',
          value: process.env.JEST_WORKER_ID // 测试时使用 unix 时间戳
            ? String(extendedInterfaceInfo.up_time)
            : /* istanbul ignore next */
              `\`${dayjs(extendedInterfaceInfo.up_time * 1000).format('YYYY-MM-DD HH:mm:ss')}\``,
        },
      ];
      if (typeof extraTags === 'function') {
        const tags = extraTags(extendedInterfaceInfo);
        for (const tag of tags) {
          (tag.position === 'start' ? summary.unshift : summary.push).call(summary, {
            label: tag.name,
            value: tag.value,
          });
        }
      }
      const titleComment = hasTitle
        ? dedent`
            * ${genTitle(description)}
            *
          `
        : '';
      const extraComment: string = summary
        .filter((item) => typeof item !== 'boolean' && !isEmpty(item.value))
        .map((item) => {
          const _item: Exclude<typeof summary[0], boolean> = item as any;
          return `* @${_item.label} ${castArray(_item.value).join(', ')}`;
        })
        .join('\n');
      return dedent`
        /**
         ${[titleComment, extraComment].filter(Boolean).join('\n')}
         */
      `;
    };

    // 请求参数额外信息
    const requestFunctionExtraInfo =
      typeof syntheticalConfig.setRequestFunctionExtraInfo === 'function'
        ? await syntheticalConfig.setRequestFunctionExtraInfo(extendedInterfaceInfo, changeCase1)
        : {};

    return dedent`
      ${genComment((title) => `接口 ${title} 的 **请求类型**`)}
      ${requestDataType.trim()}

      ${genComment((title) => `接口 ${title} 的 **返回类型**`)}
      ${responseDataType.trim()}

      ${
        syntheticalConfig.typesOnly
          ? ''
          : dedent`
            ${genComment((title) => `接口 ${title} 的 **请求配置的类型**`)}
            type ${requestConfigTypeName} = Readonly<RequestConfig<
              ${JSON.stringify(syntheticalConfig.mockUrl)},
              ${JSON.stringify(syntheticalConfig.devUrl)},
              ${JSON.stringify(syntheticalConfig.prodUrl)},
              ${JSON.stringify(extendedInterfaceInfo.path)},
              ${JSON.stringify(syntheticalConfig.dataKey) || 'undefined'},
              ${paramNameType},
              ${queryNameType},
              ${JSON.stringify(isRequestDataOptional)}
            >>

            ${genComment((title) => `接口 ${title} 的 **请求配置**`)}
            const ${requestConfigName}: ${requestConfigTypeName} = ${COMPRESSOR_TREE_SHAKING_ANNOTATION} {
              mockUrl: mockUrl${categoryUID},
              devUrl: devUrl${categoryUID},
              prodUrl: prodUrl${categoryUID},
              path: ${JSON.stringify(extendedInterfaceInfo.path)},
              method: Method.${extendedInterfaceInfo.method},
              requestHeaders: ${JSON.stringify(
                (extendedInterfaceInfo.req_headers || [])
                  .filter((item) => item.name.toLowerCase() !== 'content-type')
                  .reduce<Record<string, string>>((res, item) => {
                    res[item.name] = item.value;
                    return res;
                  }, {})
              )},
              requestBodyType: RequestBodyType.${
                extendedInterfaceInfo.method === Method.GET
                  ? RequestBodyType.query
                  : extendedInterfaceInfo.req_body_type /* istanbul ignore next */ || RequestBodyType.none
              },
              responseBodyType: ResponseBodyType.${extendedInterfaceInfo.res_body_type},
              dataKey: dataKey${categoryUID},
              paramNames: ${paramNamesLiteral},
              queryNames: ${queryNamesLiteral},
              requestDataOptional: ${JSON.stringify(isRequestDataOptional)},
              requestDataJsonSchema: ${JSON.stringify(
                syntheticalConfig.jsonSchema?.enabled && syntheticalConfig.jsonSchema?.requestData !== false ? requestDataJsonSchema : {}
              )},
              responseDataJsonSchema: ${JSON.stringify(
                syntheticalConfig.jsonSchema?.enabled && syntheticalConfig.jsonSchema?.responseData !== false ? responseDataJsonSchema : {}
              )},
              requestFunctionName: ${JSON.stringify(requestFunctionName)},
              queryStringArrayFormat: QueryStringArrayFormat.${syntheticalConfig.queryStringArrayFormat || QueryStringArrayFormat.brackets},
              extraInfo: ${JSON.stringify(requestFunctionExtraInfo)},
            }

            ${genComment((title) => `接口 ${title} 的 **请求函数**`)}
            export const ${requestFunctionName} = ${COMPRESSOR_TREE_SHAKING_ANNOTATION} (
              requestData${isRequestDataOptional ? '?' : ''}: ${requestDataTypeName},
              ...args: UserRequestRestArgs
            ) => {
              return request<${responseDataTypeName}>(
                prepare(${requestConfigName}, requestData),
                ...args,
              )
            }

            ${requestFunctionName}.requestConfig = ${requestConfigName}

            ${
              !syntheticalConfig.reactHooks || !syntheticalConfig.reactHooks.enabled
                ? ''
                : dedent`
                  ${genComment((title) => `接口 ${title} 的 **React Hook**`)}
                  export const ${requestHookName} = ${COMPRESSOR_TREE_SHAKING_ANNOTATION} makeRequestHook<${requestDataTypeName}, ${requestConfigTypeName}, ReturnType<typeof ${requestFunctionName}>>(${requestFunctionName})
                `
            }
          `
      }
    `;
  }

  async destroy() {
    return Promise.all(this.disposes.map(async (dispose) => dispose()));
  }
}

const generateFile = () => {};
