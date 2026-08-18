#!/usr/bin/env bash
# ============================================================
# 民法典答题系统 · 服务器一键部署脚本（v2，实战教训加固版）
# 适用：Ubuntu/Debian 云服务器（建议以 root 运行）
#
# 用法：
#   bash deploy.sh 你的域名.com     # 带域名：自动配 Nginx + HTTPS
#   bash deploy.sh                  # 不带域名：仅部署，IP:3000 访问
#
# 实战教训 → 已加固点：
#   1. Node 缺失或 <22 自动装/升 v22（better-sqlite3 原生模块要求 >=22，
#      否则段错误 Segfault，pm2 一直 errored）
#   2. 域名参数自动去掉 https:// 和尾部斜杠（避免 server_name/certbot/
#      PUBLIC_URL 出现 https://https:// 双协议头）
#   3. PM2 先 delete 再 start（避免旧 PUBLIC_URL 环境变量残留）
#   4. PM2 自动配置开机自启（服务器重启后服务不丢）
#   5. Nginx 配置幂等：已有配置不覆盖（避免把 certbot 的 SSL 配置覆盖掉，
#      导致 443 端口丢失、https 连接被拒）
#   6. 自动禁用 nginx 默认站点（避免域名被默认站抢走，显示 Welcome to nginx）
#   7. 安装前等待 apt 锁释放（避免 unattended-upgrades 占用报
#      "Could not get lock" 错误）
#   8. certbot 只在无 SSL 配置时申请；失败不阻断部署
# ============================================================
set -e

DOMAIN="${1:-}"
PORT="3000"
# 域名参数清理：bash deploy.sh https://域名/xxx → 域名（兼容误传）
DOMAIN="${DOMAIN#https://}"
DOMAIN="${DOMAIN#http://}"
DOMAIN="${DOMAIN%/}"
cd "$(dirname "$0")"

echo "=============================================="
echo " 步骤 1/7：准备（等待 apt 锁释放，防自动更新占用）"
echo "=============================================="
n=0
while pgrep -f "apt-get|apt |dpkg|unattended-upgr" >/dev/null 2>&1; do
  n=$((n+1))
  if [ "$n" -gt 30 ]; then
    echo "  ⚠️ apt 长时间被占用，请检查：ps aux | grep apt"
    break
  fi
  echo "  检测到 apt/自动更新在运行，等待 10 秒... ($n/30)"
  sleep 10
done

echo "=============================================="
echo " 步骤 2/7：检查/安装 Node.js（缺失或 <22 都装 v22）"
echo "=============================================="
NEED_NODE=0
if ! command -v node >/dev/null 2>&1; then
  NEED_NODE=1
else
  NODE_MAJOR=$(node -v 2>/dev/null | sed 's/v\([0-9]*\).*/\1/')
  if [ "${NODE_MAJOR:-0}" -lt 22 ]; then
    echo "  Node v${NODE_MAJOR} < 22，升级到 v22 ..."
    NEED_NODE=1
  fi
fi
if [ "$NEED_NODE" = "1" ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
echo "  Node: $(node -v)  npm: $(npm -v)"

echo "=============================================="
echo " 步骤 3/7：安装依赖（清理重装，避免原生模块版本错乱）"
echo "=============================================="
[ -d node_modules ] && rm -rf node_modules
npm install --production

echo "=============================================="
echo " 步骤 4/7：PM2 启动 + 开机自启"
echo "=============================================="
npm install -g pm2 >/dev/null 2>&1 || true
pm2 delete quiz >/dev/null 2>&1 || true   # 清旧进程与旧环境变量（防 PUBLIC_URL 残留）
if [ -n "$DOMAIN" ]; then
  PUBLIC_URL="https://${DOMAIN}" pm2 start server.js --name quiz
else
  PUBLIC_URL="${PUBLIC_URL:-}" pm2 start server.js --name quiz
fi
pm2 save
pm2 startup systemd -u "$(whoami)" --hp "$HOME" >/dev/null 2>&1 || true
systemctl enable "pm2-$(whoami)" >/dev/null 2>&1 || true
pm2 status quiz

if [ -n "$DOMAIN" ]; then
  echo "=============================================="
  echo " 步骤 5/7：Nginx 反向代理（幂等，不覆盖已有 SSL 配置）"
  echo "=============================================="
  command -v nginx >/dev/null 2>&1 || apt-get install -y nginx
  CONF=/etc/nginx/sites-available/quiz
  NEED_CONF=0
  if [ ! -f "$CONF" ]; then
    NEED_CONF=1
  elif ! grep -q "server_name ${DOMAIN}" "$CONF"; then
    echo "  检测到旧配置的域名不是 ${DOMAIN}，将重写"
    NEED_CONF=1
  fi
  if [ "$NEED_CONF" = "1" ] && ! grep -q "listen 443 ssl" "$CONF" 2>/dev/null; then
    cat > "$CONF" <<EOF
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
    ln -sf "$CONF" /etc/nginx/sites-enabled/quiz
    rm -f /etc/nginx/sites-enabled/default   # 禁用默认站点，防抢域名
    nginx -t || { echo "  ⚠️ Nginx 配置测试失败，跳过 Nginx 步骤"; SKIP_NGINX=1; }
  else
    echo "  Nginx 配置已存在且正确（含 SSL），保留不动"
  fi
  if [ -z "$SKIP_NGINX" ]; then
    systemctl enable nginx >/dev/null 2>&1 || true
    systemctl start nginx >/dev/null 2>&1 || systemctl restart nginx >/dev/null 2>&1 || true
    echo "  Nginx 就绪：http://${DOMAIN}"
  fi

  echo "=============================================="
  echo " 步骤 6/7：HTTPS 证书（已有 SSL 配置则跳过）"
  echo "=============================================="
  if grep -q "listen 443 ssl" "$CONF" 2>/dev/null; then
    echo "  已存在 SSL 配置，跳过 certbot"
  else
    command -v certbot >/dev/null 2>&1 || apt-get install -y certbot python3-certbot-nginx
    if certbot --nginx -d "${DOMAIN}" --non-interactive --agree-tos -m "admin@${DOMAIN}" --redirect; then
      echo "  HTTPS 配置成功 ✅"
    else
      echo "  ⚠️ HTTPS 配置失败，稍后手动执行：certbot --nginx -d ${DOMAIN}"
    fi
  fi
fi

echo "=============================================="
echo " 步骤 7/7：验证"
echo "=============================================="
sleep 2
echo "  /api/meta:  $(curl -s "http://127.0.0.1:${PORT}/api/meta")"
echo "  服务状态:   $(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/api/state")"

echo "=============================================="
echo " 部署完成！"
[ -n "$DOMAIN" ] && echo " 管理台/二维码: https://${DOMAIN}"
[ -z "$DOMAIN" ] && echo " 管理台/二维码: ${PUBLIC_URL:-http://服务器IP:${PORT}}"
[ -n "$DOMAIN" ] && echo " 答题页: https://${DOMAIN}/answer?section=板块id"
echo " 更新代码: cd $(pwd) && git pull && pm2 restart quiz"
echo " 清空数据: pm2 stop quiz && rm -f data/quiz.db* && pm2 restart quiz"
echo "=============================================="
