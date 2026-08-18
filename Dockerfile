# 民法典答题系统 · Docker 镜像（用于 Coolify 部署）
# 使用 Node 22（better-sqlite3 v13 要求 >=22，彻底避免版本坑）
FROM node:22-slim

# 安装构建工具（better-sqlite3 原生模块在无预编译包时兜底编译）
RUN apt-get update && apt-get install -y python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先装依赖（利用 Docker 层缓存）
COPY package*.json ./
RUN npm install --omit=dev

# 复制项目代码（questions.json 在根目录；data/ 仅运行时数据库，由持久卷挂载）
COPY . .

# 端口与数据目录（data/ 建议挂持久卷：容器重启/重建不丢答题数据）
EXPOSE 3000
ENV PORT=3000
VOLUME ["/app/data"]

CMD ["node", "server.js"]
