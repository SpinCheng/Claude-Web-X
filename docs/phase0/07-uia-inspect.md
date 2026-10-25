# Phase 0 - 07 UIA 元素勘探指南（手动操作）

目标：为 Cowork 注入管道（路线 A：唤起会话 → 剪贴板粘贴 → 模拟发送）和远程 Allow，
找到稳定的 UI Automation 定位参数，产出 `uia-selectors.json`。

## 工具（任选其一）

1. **Accessibility Insights for Windows**（推荐，微软官方，免费）
   https://accessibilityinsights.io/downloads/
2. Windows SDK 自带的 `inspect.exe`（老牌）

## 勘探步骤

### A. 输入框（composer）

1. 打开 Claude Desktop，进入任意 Cowork 会话；
2. 用工具的"选择元素"（悬停 + 点击）选中底部输入框；
3. 记录右侧属性面板中的关键属性（见下方模板）；
4. 顺带记录输入框的**祖先链**（前 3~5 层的 ClassName/Name），用于窗口内定位。

### B. 发送按钮

1. 在输入框随便打几个字（让发送按钮出现/激活）；
2. 勘探发送按钮，记录属性。

### C. 权限弹窗（Allow 按钮）

1. 在 Cowork 里发一个会触发权限确认的任务，例如：
   "在 outputs 目录创建 test.txt 后再删除它"；
2. 弹出权限弹窗时，勘探弹窗本体和 Allow/确认按钮，记录属性；
3. 如果不方便触发，也可以跳过，Phase 4 联调时再补。

### D. 终端窗口（可选，CC 实时注入用）

1. 打开 Windows Terminal / 你常用的终端跑一个 claude 会话；
2. 记录终端窗口类名（用于 SetForeground + SendKeys 注入）。

## 产出文件模板

把结果存为 `phase0/uia-selectors.json`（该文件含机器信息，已 gitignore）：

```json
{
  "desktopApp": {
    "processName": "Claude",
    "windowClassName": "<勘探后填写>",
    "version": "<设置-关于 里的版本号>"
  },
  "composer": {
    "controlType": "Document | Edit",
    "className": "<勘探后填写>",
    "automationId": "<勘探后填写>",
    "nameHint": "<勘探后填写>",
    "ancestors": ["层1 ClassName", "层2 ClassName"]
  },
  "sendButton": {
    "automationId": "",
    "nameHint": "发送 | Send"
  },
  "permissionDialog": {
    "windowNameHint": "权限 | permission | 确认",
    "allowButton": { "automationId": "", "nameHint": "允许 | Allow" }
  },
  "terminal": {
    "windowClassName": "CASCADIA_HOSTING_WINDOW_CLASS",
    "notes": ""
  }
}
```

## 判定标准

- composer 有稳定的 `AutomationId` 或唯一 `ClassName` → UIA 路线可行性高；
- 只有可变的 `Name` → 需要靠位置/祖先链定位，脆弱性上升，如实记录；
- 完全勘探不到（Electron 未暴露 accessibility 树）→ 记录此现象，Cowork 注入路线降级评估。
