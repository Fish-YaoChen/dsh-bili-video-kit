# cookies

这个目录放 B 站 cookie，**不要提交到 git**（`.gitignore` 已经排除了 `*.txt`）。

```
bilibili-login.txt   必需。扫码登录后导出的 Netscape 格式 cookie
bilibili.txt         可选。更早的一份，认证通常已过期，只借它的匿名设备号
```

格式（一行一个 cookie，制表符分隔）：

```
# domain        includeSubdomains  path  secure  expire       name      value
.bilibili.com   TRUE               /     FALSE   0            SESSDATA  <...>
```

认证只认这三个：`SESSDATA`、`bili_jct`、`DedeUserID`。

想放别处就设环境变量：

```bash
export BILI_COOKIE_DIR=/path/to/cookies
```

怎么导出：浏览器登录 B 站之后，用任意 cookie 导出扩展导出 Netscape 格式即可。**这是你自己的账号，别把文件发给别人。**
