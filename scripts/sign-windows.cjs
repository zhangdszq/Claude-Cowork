/**
 * Windows 代码签名脚本
 * 
 * 注意：EV 证书需要硬件 Token，如果 Token 未插入会跳过签名
 * 打包完成后可以手动运行签名
 */

const { execSync } = require('child_process');
const path = require('path');

// 签名工具和证书配置 (参考 win-nsis/sign.bat)
const SIGNTOOL_PATH = path.join(__dirname, '..', 'win-nsis', 'signtool.exe');
const CERT_NAME = 'Beijing Dami Technology';  // 证书名称（部分匹配）
// 时间戳服务器
const TIMESTAMP_SERVER = 'http://timestamp.sectigo.com';

// 设置为 true 跳过签名（打包后手动签名）
const SKIP_SIGNING = process.env.SKIP_SIGNING === 'true';

exports.default = async function sign(configuration) {
    if (SKIP_SIGNING) {
        console.log(`Skipping signing (SKIP_SIGNING=true): ${configuration.path}`);
        return;
    }

    const filePath = configuration.path;
    
    // 跳过某些系统文件的签名
    const fileName = path.basename(filePath);
    if (fileName.startsWith('api-ms-') || fileName.startsWith('vcruntime')) {
        console.log(`Skipping system file: ${fileName}`);
        return;
    }

    console.log(`Signing: ${filePath}`);

    try {
        // 使用 RFC 3161 时间戳 (/tr 和 /td 参数)
        const command = `"${SIGNTOOL_PATH}" sign /tr ${TIMESTAMP_SERVER} /td sha256 /n "${CERT_NAME}" /fd sha256 "${filePath}"`;
        
        execSync(command, {
            stdio: 'inherit'
        });
        
        console.log(`Successfully signed: ${fileName}`);
    } catch (error) {
        console.error(`Failed to sign ${filePath}:`, error.message);
        console.log(`\n提示: EV 证书需要硬件 Token。请确认 SafeNet Token 已插入。`);
        console.log(`或者设置环境变量 SKIP_SIGNING=true 跳过签名。\n`);
        throw error;
    }
};

