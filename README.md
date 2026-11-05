# 安全管理数据工作台（EHS Workbench）

纯前端的安全管理数据平台。**打开网页即用，无需安装任何软件。**

🌐 **在线访问**：https://xuezhi024.github.io/EHS-wordbench/

> 如果打不开，需要在仓库 Settings → Pages 里把 Source 设为 `main` / `(root)`。

---

## 功能

| 模块 | 内容 |
|---|---|
| 综合看板 | 20 项 KPI、7 个图表、7 类待办提醒，支持日期范围与部门筛选 |
| 隐患排查治理 | 登记 → 整改 → 验收 → 关闭 全流程闭环，逾期自动标红 |
| 风险分级管控 | LEC 法自动计算风险值 R 与四色分级 |
| 安全疑虑 | 员工反映的安全顾虑，核实后转隐患或答复关闭，支持匿名 |
| 事故事件管理 | 按公司标准分 6 大类，急救箱/医疗处置/一般事故细分为 A/B/C 级 |
| 教育培训 | 三级教育、专项培训、考核记录 |
| 人员资质证照 | 特种作业证台账，到期前 30 天自动提醒 |
| 消防设施器材 | 点检周期管理，自动推算下次点检日期 |
| 设备管理 | 特种设备、表阀、其他类，检验到期提醒 |
| 应急演练 | 演练计划、实施、评估闭环 |
| 承包商管理 | 准入审核、资质有效期、违章记录 |
| 作业许可票 | 八大作业票、监护人、时效跟踪 |

**通用能力**：Excel 导入导出、HTML 报表导出、搜索筛选排序分页、状态流转、数据备份恢复。

---

## 快速开始

### 在线使用

直接打开 https://xuezhi024.github.io/EHS-wordbench/

数据保存在**你自己的浏览器**里（localStorage），不会上传到服务器。

### 本地运行

因为涉及 ES 模块与相对路径，建议用任意静态服务器打开：

```bash
# Python 自带
python -m http.server 8000

# 或 Node
npx serve .
```

然后访问 http://localhost:8000/

> 直接双击 `index.html` 也能用（file:// 协议），但部分浏览器会限制某些功能。

---

## 数据说明

### 数据存在哪

浏览器 `localStorage`，键名 `ehs_workbench_data_v1`。

- ✅ 换页面、刷新、关浏览器都不会丢
- ❌ 换设备、换浏览器、清缓存会丢
- ❌ 不同人看到的是各自的数据，不共享

### 备份与恢复

点侧栏底部 **「数据管理」**：

| 操作 | 说明 |
|---|---|
| 导出全部数据 | 下载 JSON 备份文件 |
| 导入数据 | 用备份覆盖当前数据 |
| 恢复初始数据 | 丢弃修改，回到数据包内容 |
| 清空所有数据 | 删除全部记录 |

**建议每周导出一次备份。**

### 更新数据包

想让所有人看到新数据，需要重新生成数据包并推送：

```bash
node tools/build-bundle.mjs          # 从 data/*.json 生成（需本地有数据）
node tools/build-bundle.mjs --demo   # 生成演示数据
git add web/data/bundle.js
git commit -m "更新数据"
git push
```

推送后 GitHub Pages 会自动部署，1-2 分钟生效。

⚠️ 已经打开过网页的浏览器不会自动拉新数据，需要点「数据管理 → 恢复初始数据」。

---

## 技术栈

| 层 | 实现 |
|---|---|
| 前端框架 | 原生 HTML/CSS/JavaScript（零依赖） |
| 图表 | Canvas 手绘（实时看板）+ SVG（HTML 报表） |
| 数据存储 | localStorage |
| Excel | 手写 XLSX 读写（ZIP + OOXML），无第三方库 |
| 部署 | GitHub Pages |

**完全离线可用**，断网也能打开（首次加载后）。

---

## 目录结构

```
.
├── index.html              跳转页（→ web/）
├── web/
│   ├── index.html          应用主页面
│   ├── app.js              路由、列表/表单引擎、看板
│   ├── localapi.js         数据层（localStorage，复刻后端全部逻辑）
│   ├── biz.js              Excel 导入导出、HTML 报表生成
│   ├── excel.js            手写 XLSX 读写（ZIP + OOXML）
│   ├── charts.js           Canvas 图表
│   ├── styles.css          样式
│   └── data/
│       └── bundle.js       数据包（由 tools/build-bundle.mjs 生成）
├── tools/
│   ├── build-bundle.mjs    生成数据包
│   └── schema.json         集合与字段定义（唯一真源）
├── app/
│   └── statictest.mjs      自动化测试
└── docs/                   文档与截图
```

---

## 开发说明

### 加一个字段

1. 修改 `tools/schema.json` 里对应集合的 `fields`
2. 如需计算字段，在 `web/localapi.js` 的 `COMPUTERS` 里加计算函数
3. 重新生成数据包：`node tools/build-bundle.mjs`

列表列、表单控件、Excel 表头、校验规则都会自动跟着变，前端无需改代码。

### 运行测试

```bash
node app/statictest.mjs
```

31 项自动化测试，覆盖：模式检测、数据加载、页面渲染、图表、列表、搜索、新增、持久化、刷新保留、数据管理、Excel 读写、导入校验、HTML 报表、状态流转、删除。

---

## 文档

- [使用说明](docs/使用说明.md) — 操作手册、导入导出、常见问题
- [事件等级标准](docs/事件等级标准.md) — A/B/C 分级判定
- [数据模型设计](docs/数据模型设计.md) — 字段定义、状态机、KPI 口径
- [网页版部署](docs/网页版部署.md) — GitHub Pages 部署细节
- [HTML 报表](docs/HTML报表.md) — 报表导出与打印
- [数据管理](docs/数据管理.md) — 数据位置与更新方式

---

## 许可

内部使用项目。
