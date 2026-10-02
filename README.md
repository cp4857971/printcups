# 打印中心 PrintCenter

fnOS（飞牛 OS）网络打印管理应用，基于 CUPS 2.4.2 源码编译运行时，中文窗口化界面。

## 功能
- 全部功能窗口化，所有用户登录验证（默认超管 admin/admin）
- 打印机添加 / 删除 / 编辑 / 设置默认 / 共享给局域网
- 213+ 主流品牌打印机驱动（佳能 / 爱普生 / 兄弟 / 施乐 / 柯尼卡美能达 / 利盟 / 夏普 / 东芝 / OKI / HP / 戴尔 等），支持品牌型号搜索过滤
- 测试页打印、文件打印、打印作业管理
- 用户权限管理（超级管理员 / 管理员 / 操作员）
- 安装向导可自定义数据存储路径与服务端口

## 安装
在 fnOS 应用中心 → 手动安装，选择 `printcups-v0.0.5.fpk`（v0.0.5 已发布）。

**下载地址**：
- GitHub Release（安装包 + 源码）：https://github.com/cp4857971/printcups/releases
- 安装包直链：https://github.com/cp4857971/printcups/raw/main/printcups-v0.0.5.fpk

## 构建
需要 fnpack（fnOS 应用打包工具）：

```bash
fnpack build --directory .
```

## 目录结构
- `app/`：应用运行时（`server/` Node 后端 + `public/` 前端；`cups/` CUPS 2.4.2 运行时）
- `cmd/`：生命周期脚本（install / config / upgrade / uninstall / main）
- `config/`：权限（run-as package）与数据共享资源
- `wizard/`：安装向导
- `manifest`：应用元信息（开发者 / 发布者：cp）

## 说明
`app/cups`（CUPS 2.4.2 编译运行时，约 35MB）未包含在本仓库，完整安装包以 `.fpk` 形式在 Releases 提供；如需自建，可编译 CUPS 2.4.2（configure `--prefix=<安装目录>/cups --with-components=all`）并放置于 `app/cups`。

## 开发者 / 发布者
cp
