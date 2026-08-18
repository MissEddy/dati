# 在 Coolify 上部署本项目的完整流程

> 适用：Coolify v4（Railpack/Traefik 版本）· Ubuntu 服务器
> 项目：Node.js + Express + SQLite（better-sqlite3，要求 Node ≥ 22）

---

## 〇、前置检查（先确认，再操作）

在**本机**执行，确认以下文件已提交到 git 仓库：

```bash
cd /Users/pidan/Desktop/民法典/答题系统
git ls-files | grep -E "Dockerfile|questions.json|server.js|package.json"
```

必须看到 4 行输出。**缺 Dockerfile 是导致 Coolify 走错构建方式的最常见原因**。

另外确认域名解析：`quiz.你的域名.com` 的 **A 记录已指向服务器 IP**（配 HTTPS 必需）。

---

## 一、Coolify 新建应用

1. Coolify 面板 → 左侧 **Projects** → 进入你的 Project（或新建）
2. 右上角 **+ New Resource** → **Application**
3. 选择仓库：
   - 选 GitHub 里的 **MissEddy/dati**，分支 **main**
   - ⚠️ 私有仓库：需先在 Coolify **Sources** 里配置 GitHub App 或 SSH Key，否则拉不到代码

---

## 二、关键配置（每一项都要对，错一个都不行）

| 配置项 | 填什么 | 为什么 |
|---|---|---|
| **Build Pack** | **`Dockerfile`** | ⚠️ **最关键**。选错成 Railpack/Nixpacks 就不会用你的 Dockerfile，Node 版本/构建工具不可控，better-sqlite3 容易装不上 |
| **Ports Exposes** | **`3000`** | 容器内监听端口，Traefik 靠它路由流量 |
| Domains | `quiz.你的域名.com` | Coolify 自动配 Traefik 路由 + Let's Encrypt 免费 HTTPS |
| Health Check（可选） | `GET /api/state` | 让 Coolify 正确判断容器健康 |

---

## 三、环境变量

```
PORT=3000
PUBLIC_URL=https://quiz.你的域名.com
```

- `PORT`：容器内端口，与 Ports Exposes 一致
- `PUBLIC_URL`：**必须设**，否则二维码/复制链接生成的是容器内部地址，手机扫不了

---

## 四、持久存储（防止容器重建丢数据）

**Persistent Storage → Volume Mount**：

```
Type:      Volume Mount   （不要选 File Mount / Host File Mount）
Destination Path:  /app/data
Name:      quiz-data
```

原因：SQLite 是 **WAL 模式**，运行时在 `data/` 里生成 `quiz.db`、`quiz.db-wal`、`quiz.db-shm` **三个文件**，必须挂整个目录；只挂单文件会导致数据损坏或丢失。

---

## 五、部署

点 **Deploy** → 打开 **Build Logs** 看构建：

- **成功标志**：镜像构建完成 → 容器 `running` → 域名可访问
- 第一次构建较慢（拉 node:22 镜像 + npm install + 编译 better-sqlite3，约 2-5 分钟属正常）
- 构建日志里出现红色报错 → 把最后 20 行发我

---

## 六、部署后验证

| 检查项 | 方法 |
|---|---|
| 管理台 | 浏览器打开 `https://quiz.你的域名.com` |
| 答题页 | 手机访问 `https://quiz.你的域名.com/answer?section=jyyw` |
| 二维码 | 管理台下载二维码 → 手机扫码能打开答题页 |
| 数据持久 | Deploy 页点 **Redeploy** 重建容器后，答题数据还在（卷生效） |

---

## 常见问题速查

| 现象 | 原因 | 解决 |
|---|---|---|
| 构建用的是 Railpack（日志出现） | Build Pack 没选 Dockerfile | 设置里改 **Dockerfile** 后 Redeploy |
| 拉不到代码 | 私有仓库没授权 | Coolify Sources 配 GitHub App / SSH Key |
| 构建报 better-sqlite3 编译错 | 基础镜像 Node 版本旧或缺构建工具 | 用项目自带 Dockerfile（node:22 + g++），不要用 Railpack |
| 容器起来但域名打不开 | Ports Exposes 不对 | 设为 `3000` |
| 二维码扫出来是内网地址 | PUBLIC_URL 没设 | 设成 `https://quiz.你的域名.com` 后 Redeploy |
| 重建容器后数据没了 | 没挂持久卷 | Volume Mount → `/app/data` |
| HTTPS 失败 | 域名 A 记录没解析 / 刚解析没生效 | 确认解析，等 5-10 分钟再 Redeploy |
