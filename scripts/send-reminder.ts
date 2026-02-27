import { getAccessToken, sendProactiveText } from '../src/electron/libs/dingtalk-bot.ts';
import { readFileSync } from 'fs';

const config = JSON.parse(readFileSync('/Users/zhang/.vk-cowork/bot-config.json', 'utf-8'));

const token = await getAccessToken(config.appKey, config.appSecret);
console.log('Token:', token);

const result = await sendProactiveText({
  token,
  robotCode: config.appKey,
  targetUserIds: ['1446280924232650'],
  text: '🔔 提醒：张昕伟，吃鸡蛋啦！'
});
console.log('Result:', JSON.stringify(result, null, 2));
