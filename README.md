1.git clone 本项目

2.进入当前项目，修改env里面代理地址为自己的

3.docker compose up -d 运行项目

4.登录项目，从ytb粘贴url地址点击加载可缓存到本地可循环播放。

首页访客数按北京时间统计每日独立访客，同一 IP 和浏览器 Cookie 当天只计一次。每日数据保存在 `cache/visitors.json`，容器重启后仍保留；通过 OAuth 登录时会将用户名和邮箱一并记录。
