# yapi-to-ts README

本项目 fork 自[yapi-to-typescript](https://github.com/fjc0k/yapi-to-typescript)，是其 vsCode 插件实现版；

插件的开发初衷是避免将`yapi-to-typescript`工具包依赖集成到项目中，做到随时可用、任意可用；

## Usage

当前版本为`0.0.1`版本，共提供两条指令`生成yapi接口定义文件`、`沿用最近yapi配置`，你可通过点击`F1`或`Ctrl Shift P`来唤起控制台，输入`yapi`即可定位这两条指令；

这两条指令的实际功能都是用作生成`接口类型定义文件`，区别在于第一条指令需要输入`部署域名`和`项目token`
，而第二条指令会沿用你上一次的配置参数(假定你不需要修改域名和项目的情况下)；

关于`部署域名`：

即 yapi 服务器完整域名，注意：请勿在域名后加入无效后缀，或未加域名协议头；
正确域名示例： http://127.0.0.1:8080/

关于`token`：

![token](https://fjc0k.github.io/yapi-to-typescript/handbook/static/copyProjectToken.2577db66.png)

## Features

### 0.0.1

- 集成`接口类型定义文件`生成功能；
