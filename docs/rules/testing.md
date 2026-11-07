# rules/testing — 写/跑测试前必读

`npm test` = 125 单测（parsers/turns/adapter/cost/commands/agents/titlegen/runner/md/archives）+ 14 e2e（隔离桥 :3799 + 合成转录 + headless Edge CDP）。

- fixture 勿走 bash 内联（反斜杠被吃）——一律 Write 写文件再读。
- harness 的 api() 头必须合并非替换。
- harness 停桥必须 `closeAllConnections()` + 等 close 回调——server.close() 不等 keep-alive 排空，Windows 允许双绑 :3799 → 新旧桥竞态应答。
- e2e 场景只经 run-all 跑（结尾显式 process.exit），单场景直跑因残留句柄不退出，勿误判为新回归。
- 预览类断言先断 `#html-prev`/`#lightbox` 容器（默认 hidden），**勿断 `#hp-frame`**（异步 fetch 未完成即假通过）。
