FROM ogs59/mc:v1
RUN apk add --no-cache tzdata
COPY server.js /app/server.js
ENV TZ=Asia/Shanghai
