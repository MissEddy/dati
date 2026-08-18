# 民法典宣讲答题系统 · 部署说明

一个部署在云服务器上的扫码答题 + 实时大屏展示系统。手机扫码答题，大屏实时看战况，最后公布前三名。

## 一、功能一览

- **管理台**（`/`）：按板块生成二维码（可下载 PNG 贴进 PPT）、打开各展示页
- **答题页**（`/answer?section=板块id`）：手机扫码进入，填昵称答题，提交后展示答题报告
- **分区实时展示页**（`/display?section=板块id`）：某板块的各题答题情况（回答人数/正确率/各选项占比/正确答案）+ 实时动态排名
- **最终总览页**（`/final`）：前三名颁奖台 + 全部用户实时总排名

## 二、环境要求

- Node.js ≥ 18（推荐 20/22）
- 一台可公网访问的云服务器（阿里云/腾讯云等），建议开放 80/443（用域名）或任意端口

## 三、上传与安装

```bash
# 1. 把整个「答题系统」目录上传到服务器（scp / git / 宝塔均可）
#    例如放到 /opt/quiz

cd /opt/quiz

# 2. 安装依赖
npm install --production

# 3. 启动（先跑起来验证）
node server.js
# 看到「答题系统已启动」即成功
```

## 四、环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `PORT` | 服务端口 | `3000` |
| `PUBLIC_URL` | 对外公网地址（带域名时填，如 `https://quiz.example.com`） | 空（用访问地址自动生成二维码） |

## 五、正式运行（推荐用 PM2 守护进程）

```bash
# 全局安装 pm2
npm i -g pm2

# 启动
pm2 start server.js --name quiz

# 开机自启
pm2 save && pm2 startup
```

## 六、配置域名 + HTTPS（推荐，手机扫码体验更好）

用 Nginx 反向代理把域名指向 3000 端口，并配置 HTTPS：

```nginx
server {
    listen 80;
    server_name quiz.example.com;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

> HTTPS 可用 `certbot` 免费签发。配置好域名后，启动时带上：
> `PUBLIC_URL=https://quiz.example.com pm2 restart quiz --update-env`
> 这样二维码就会指向你的公网域名，手机在任何有网的地方都能扫码答题。

## 七、活动当天操作流程

1. 电脑打开 `https://你的域名/`（管理台）
2. 讲完一个板块，就**下载该板块二维码**贴到 PPT 投屏，或直接把二维码投屏
3. 群众扫码答题；同时把该板块「实时展示页」投到大屏看战况
4. 全部板块答完，打开「最终总览页」看总排名
5. 最终总览页实时展示前三名颁奖台和总排名，作为颁奖背景

## 八、数据库

数据用 **SQLite** 存储（免安装、单文件），文件为 `data/quiz.db`，启动时自动建库建表：

- `answers` 表：答题记录（昵称、板块、答案、对错数、时间）
- `owners` 表：昵称归属（同名防撞，同一昵称只能由同一设备使用）

相关说明：

- 系统**不提供重置功能**；如需清空数据，停止服务后删除 `data/quiz.db`，下次启动会自动重建空库
- 备份：复制 `data/quiz.db` 即可
- 无需额外安装数据库服务，`npm install` 时已包含 SQLite 驱动

## 十、压力测试（可选）

项目内置压测脚本，可验证服务器稳定性（本机 200/500 并发实测：吞吐 2400-3300 请求/秒，零失败）：

```bash
# 在项目目录运行（先启动服务）
N=500 POLLS=100 node tools/stress-test.js
# 环境变量：N=并发答题用户数，POLLS=并发查询次数，BASE=服务地址，SECTION=板块id
```

> 注意：压测会在数据库写入大量测试数据，压完请清空（停止服务后删除 `data/quiz.db`）。

## 九、实战教训与常见问题排查（重要）

以下问题都曾在真实部署中踩过，**已全部在 `deploy.sh` v2 和代码中加固**，但了解原因有助于手动排查：

| # | 问题 | 原因 | 修复/排查 |
|---|---|---|---|
| 1 | 服务起不来，`pm2` 显示 `errored`、日志空、`node server.js` 段错误 | Node 版本 < 22，better-sqlite3 原生模块 ABI 不兼容 | 升级 Node 22：`curl -fsSL https://deb.nodesource.com/setup_22.x \| bash - && apt-get install -y nodejs`，然后 `rm -rf node_modules && npm install --production` |
| 2 | 链接变成 `https://https://域名/...` | `PUBLIC_URL` 或域名参数带了协议头，重复拼接 | 代码已自动纠正重复协议头；部署时域名参数不带 `https://` |
| 3 | 域名访问显示 `Welcome to nginx!`（默认页） | nginx 默认站点抢了域名，或 `server_name` 写成了带 `https://` 的坏值 | 删除 `sites-enabled/default`；确认 `server_name` 为干净域名 |
| 4 | HTTPS 连不上（`Connection refused` 443） | 重写 nginx 配置时覆盖了 certbot 加的 SSL 配置 | 重新执行 `certbot --nginx -d 域名`；或重跑 `deploy.sh`（v2 已幂等，不覆盖已有 SSL） |
| 5 | 安装时报 `Could not get lock /var/lib/dpkg/lock-frontend` | 系统自动更新（unattended-upgrades）占用 apt | 等待几分钟自动释放（脚本已自动等待）；不要 `rm` 锁文件 |
| 6 | 服务器重启后服务没了 | PM2 未配置开机自启 | `pm2 startup systemd -u root --hp /root && pm2 save`（脚本已自动完成） |
| 7 | 改了 `PUBLIC_URL` 不生效 | pm2 记住了旧的环境变量 | `pm2 delete quiz` 后重新 `pm2 start`（脚本已自动处理） |
| 8 | certbot 报 `appears to be a URL` | 域名参数带了 `https://` | `certbot --nginx -d 域名`（不带协议头） |

**通用排查三连**：

```bash
pm2 logs quiz --lines 20      # 看应用报错
ss -tlnp | grep -E ':(80|443|3000)'   # 看端口监听
curl http://127.0.0.1:3000/api/meta   # 看 PUBLIC_URL 是否正确
```

## 十、修改题目

题库在 `questions.json`（项目根目录），结构为「板块 → 题目」，字段：

- `type`：`judge`（判断题，选项为对/错）或 `choice`（单选题）
- `options`：选项数组
- `answer`：正确答案（判断填"对/错"，单选填选项原文）
- `explain`：解析（当前版本前端不展示，供主持人讲解参考）

改完重启服务即可生效。
