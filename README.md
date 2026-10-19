# vite-plugin-client-error-logger

在 Vite 开发模式下注入浏览器端监控脚本，采集 `window.onerror`、`unhandledrejection`、`console.error` 等运行时错误，并通过自建接口落地到本地日志文件，方便沙盒 / 自动化环境排查前端异常。

## 特性

- 自动在所有入口 HTML 注入内联脚本，无需手动修改模板；
- 兼容 `navigator.sendBeacon` 与 `fetch` 上报，避免刷新或导航导致日志丢失；
- 支持 `console.warn` 可选捕获、请求体大小限制、日志目录自定义等配置；
- 默认仅在 `vite dev` 生效（`apply: 'serve'`），不影响生产构建；
- 日志按文本格式落在 `.logs/client-errors.log`，适合 `tail -f` 或脚本解析。
- 每条日志以 `##__CLIENT_ERROR_LOGGER_ENTRY__##` 开头，便于使用 `rg`/`awk` 等工具筛选最新记录。

## 兼容性

- Vite 5.x、6.x、7.x、8.x
- Node.js 18 及以上版本

## 安装

```bash
pnpm add -D vite-plugin-client-error-logger
# 或
npm install -D vite-plugin-client-error-logger
```

## 使用

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import clientErrorLogger from 'vite-plugin-client-error-logger';

export default defineConfig({
  plugins: [
    react(),
    clientErrorLogger({
      // endpoint: '/__client-error',
      // logDir: '.logs',
      // logFileName: 'client-errors.log',
      // captureConsoleWarn: false,
      // maxBodySize: 64_000,
    }),
  ],
});
```

启动 `pnpm run dev` 后在浏览器触发一个运行时错误（例如调用不存在的方法），即可在 `.logs/client-errors.log` 中看到记录。

## 配置项

| 选项                 | 类型      | 默认值              | 说明                             |
| -------------------- | --------- | ------------------- | -------------------------------- |
| `endpoint`           | `string`  | `/__client-error`   | 浏览器上报的接口路径             |
| `logDir`             | `string`  | `.logs`             | 日志目录（相对 `process.cwd()`） |
| `logFileName`        | `string`  | `client-errors.log` | 日志文件名                       |
| `captureConsoleWarn` | `boolean` | `false`             | 是否额外捕获 `console.warn`      |
| `maxBodySize`        | `number`  | `64_000`            | 接口可接受的请求体上限（字节）   |

## 开发调试

本项目使用 Vite 8 进行开发验证，建议使用 Node.js 22.12 及以上版本。

本仓库内可先通过相对路径引入 `src` 目录验证功能，确认无误后执行：

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm test
```

构建产物输出到 `dist/`，即可发布到 npm。
