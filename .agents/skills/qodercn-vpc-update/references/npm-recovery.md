# npm 全局 QoderCN CLI 故障恢复

只在正常更新失败时读取本文件。保留原 npm 全局安装和国内镜像配置，按证据进入分支。

## EEXIST / 悬空入口

1. 用 `npm prefix -g`、`npm root -g` 定位当前安装，检查两个 bin 的类型、链接目标与目标是否存在。备份旧包目录与入口元数据；备份放到包目录外，避免 npm 清理时丢失。
2. **仅当入口是符号链接且目标已经不存在**，确认属于此包/此前备份后移除对应链接。正常文件、仍有效的链接或未知来源入口先停下，不能覆盖。

```bash
PREFIX="$(npm prefix -g)"
# 以下每条只在该入口已证实为本包的悬空链接后执行。
unlink "$PREFIX/bin/qodercn"
unlink "$PREFIX/bin/qoderclicn"
```

只坏一个就只移除一个。重新执行 Skill 中固定版本 npm install 与 rebuild。npm bin 下入口和 shell 实际解析的入口可能不同，最后检查 PATH 遮蔽。

## 下载超时 / 镜像缓存

目标版本从本轮 npm 元数据获取，不固定为历史 1.1.65。先读取目标包 `dist.tarball`、`dist.integrity`，优先使用其 tarball URL；国内 CDN 路径仅在原 URL 超时且确认包/版本对应时使用：

```bash
TARGET='<target>'
TMP_DIR="$(mktemp -d)"
TGZ="$TMP_DIR/qoderclicn-$TARGET.tgz"
curl -fL --connect-timeout 3 --max-time 30 \
  -o "$TGZ" \
  "https://cdn.npmmirror.com/packages/%40qodercn-ai/qoderclicn/$TARGET/qoderclicn-$TARGET.tgz"
```

通过 Node crypto 对 tgz 做目标 `dist.integrity` 指定算法的校验；检查包内 package.json 的 name/version。任何不匹配停止安装。示例（环境变量值来自元数据）：

```bash
TGZ="$TGZ" EXPECTED_INTEGRITY='<dist.integrity>' node --input-type=module -e '
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const expected = process.env.EXPECTED_INTEGRITY;
const split = expected.indexOf("-");
const algorithm = expected.slice(0, split);
const actual = createHash(algorithm).update(readFileSync(process.env.TGZ)).digest("base64");
if (split < 1 || actual !== expected.slice(split + 1)) throw Error("tarball integrity mismatch");
console.log("tarball integrity verified");
'
npm cache add "$TGZ"
npm install -g "@qodercn-ai/qoderclicn@$TARGET" \
  --include=optional --ignore-scripts --fetch-retries=0 --fetch-timeout=10000
npm rebuild -g @qodercn-ai/qoderclicn --foreground-scripts
```

`npm cache add` 不保证后续 metadata/optional dependency 离线可用；继续失败时按具体失败包诊断，不能把缓存步骤作为安装成功证据。验证两个版本命令/help/真实短请求后删除**本轮创建**的 tgz 与空临时目录。失败时保留旧包回退点，不先卸载可用旧版，不改全局 registry，不使用 --force。

## rebuild 或平台包失败

读取安装脚本/optionalDependencies 与 npm 错误，核对 OS、arch、Node engines。用原包支持的安装脚本修复；保留失败日志中的脱敏诊断。包脚本可能改 PATH/dispatcher，验收实际解析路径。凭据问题不是 npm 安装问题，不尝试重新登录或输出 auth 文件以“修复安装”。
