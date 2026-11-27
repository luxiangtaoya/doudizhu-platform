// 配置：默认值 + config.json 覆盖 + 环境变量覆盖。
// 目标是「拷走目录就能跑」，所以任何配置都不依赖注册表或系统环境。
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULTS = {
  port: 8080,
  host: '0.0.0.0',
  passphrase: '95599',
  turnSeconds: 30,
  bidSeconds: 15,
  gomokuTurnSeconds: 60,
  xiangqiTurnSeconds: 60,
  graceSeconds: 15,
  maxMultiplier: 16,
  roomIdleMinutes: 10,
  botDelayMs: 900,
  botJitterMs: 400,
  dataDir: 'data',
  sessionHours: 12,
  wsHeartbeatMs: 25000,
};

export function loadConfig(rootDir) {
  const file = path.join(rootDir, 'config.json');
  let fromFile = {};
  try {
    fromFile = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[config] 读取 config.json 失败，使用默认值：${err.message}`);
    }
  }

  const cfg = { ...DEFAULTS, ...fromFile };

  // 环境变量优先级最高，方便临时改端口/口令
  if (process.env.PORT) cfg.port = Number(process.env.PORT);
  if (process.env.PASS) cfg.passphrase = String(process.env.PASS);
  if (process.env.HOST) cfg.host = String(process.env.HOST);

  cfg.port = Number.isFinite(cfg.port) ? cfg.port : DEFAULTS.port;
  cfg.turnSeconds = Math.max(10, Number(cfg.turnSeconds) || DEFAULTS.turnSeconds);
  cfg.bidSeconds = Math.max(5, Number(cfg.bidSeconds) || DEFAULTS.bidSeconds);
  cfg.graceSeconds = Math.max(3, Number(cfg.graceSeconds) || DEFAULTS.graceSeconds);
  cfg.maxMultiplier = Math.max(1, Number(cfg.maxMultiplier) || DEFAULTS.maxMultiplier);
  cfg.dataDir = path.isAbsolute(cfg.dataDir) ? cfg.dataDir : path.join(rootDir, cfg.dataDir);

  return cfg;
}
