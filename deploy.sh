#!/usr/bin/env bash
# ============================================================
# 民法典答题系统 · 服务器一键部署脚本
# 适用：Ubuntu/Debian 云服务器（建议以 root 运行）
#
# 使用方法：
#   1) 把整个「答题系统」目录上传到服务器，例如：/opt/quiz
#   2) 进入目录：cd /opt/quiz
#   3) 执行：bash deploy.sh 你的域名.com
#      （不带域名参数 = 仅部署，用 IP:3000 访问；
#        带域名 = 自动配 Nginx 反代 + 免费 HTTPS）
# ============================================================
set -e

DOMAIN="${1:-}"
PORT="3000"
# 兼容误传：bash deploy.sh https://域名/xxx → 自动去掉协议头和尾部斜杠
DOMAIN="${DOMAIN#https://}"
DOMAIN="${DOMAIN#http://}"
DOMAIN="${DOMAIN%/}"

echo "=============================================="
echo " 步骤 1/6：检查/安装 Node.js"
echo "=============================================="
# 检查 Node：缺失或版本 < 22 都装 22（better-sqlite3 v13 要求 >=22）
NEED_NODE=0
if ! command -v node >/dev/null 2>&1; then
  NEED_NODE=1
else
  NODE_MAJOR=$(node -v 2>/dev/null | sed 's/v\([0-9]*\).*/\1/')
  if [ "${NODE_MAJOR:-0}" -lt 22 ]; then
    echo "检测到 Node v${NODE_MAJOR}（低于 22），将升级到 v22 ..."
    NEED_NODE=1
  fi
fi
if [ "$NEED_NODE" = "1" ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
echo "Node: $(node -v)  npm: $(npm -v)"

echo "=============================================="
echo " 步骤 2/6：安装项目依赖"
echo "=============================================="
npm install --production

echo "=============================================="
echo " 步骤 3/6：安装 PM2 进程守护"
echo "=============================================="
npm install -g pm2 || echo "（PM2 已存在或安装跳过）"

if [ -n "$DOMAIN" ]; then
  echo "=============================================="
  echo " 步骤 4/6：配置 Nginx 反向代理 → $DOMAIN"
  echo "=============================================="
  command -v nginx >/dev/null 2>&1 || apt-get install -y nginx
  cat > /etc/nginx/sites-available/quiz <<EOF
server {
    listen 80;
    server_name ${DOMAIN};
    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
    }
}
EOF
  ln -sf /etc/nginx/sites-available/quiz /etc/nginx/sites-enabled/quiz
  nginx -t || { echo "⚠️ Nginx 配置测试失败，跳过 Nginx 步骤"; SKIP_NGINX=1; }
  if [ -z "$SKIP_NGINX" ]; then
    systemctl enable nginx >/dev/null 2>&1 || true
    if ! systemctl start nginx 2>/dev/null; then
      echo "⚠️ Nginx 启动失败（配置语法正确，最常见是 80 端口被占用）"
      echo "   排查: ss -tlnp | grep ':80'"
      echo "   如被 apache2 占用: systemctl stop apache2 && systemctl disable apache2 && systemctl start nginx"
      echo "   已跳过 Nginx，继续部署（稍后可手动修复）"
    else
      echo "Nginx 已就绪：http://${DOMAIN}"
    fi
  fi
fi

echo "=============================================="
echo " 步骤 5/6：以 PM2 启动服务"
echo "=============================================="
if [ -n "$DOMAIN" ]; then
  # 关键：PUBLIC_URL 设为域名，二维码/复制链接才会用域名
  PUBLIC_URL="https://${DOMAIN}" pm2 start server.js --name quiz --update-env
else
  # 不带域名：若外部传了 PUBLIC_URL（如 http://域名:3000）则使用，否则用服务器 IP:端口
  PUBLIC_URL="${PUBLIC_URL:-}" pm2 start server.js --name quiz --update-env
fi
pm2 save
pm2 startup 2>/dev/null || true
pm2 status quiz

if [ -n "$DOMAIN" ]; then
  echo "=============================================="
  echo " 步骤 6/6：申请免费 HTTPS 证书"
  echo "=============================================="
  command -v certbot >/dev/null 2>&1 || apt-get install -y certbot python3-certbot-nginx
  certbot --nginx -d "${DOMAIN}" --non-interactive --agree-tos -m admin@"${DOMAIN}" --redirect || {
    echo "HTTPS 自动配置失败（可能域名解析未生效），稍后手动执行：";
    echo "  certbot --nginx -d ${DOMAIN}";
  }
fi

echo "=============================================="
echo " 部署完成！"
echo " 管理台/二维码: ${PUBLIC_URL:-http://你的服务器IP:${PORT}}"
echo " 答题页: ${PUBLIC_URL:-http://你的服务器IP:${PORT}}/answer?section=板块id"
echo " 数据清空: 停止服务后删除 data/quiz.db（自动重建空库）"
echo "=============================================="
