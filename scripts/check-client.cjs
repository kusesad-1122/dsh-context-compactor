const fs = require('fs')
const s = fs.readFileSync('D:/deepseek/dsh-context-compactor/lib/client.js', 'utf8')
console.log('has 压缩总结:', s.includes('压缩总结'))
console.log('has __ModuleLoader__.load:', s.includes('__ModuleLoader__.load'))
console.log("has execute('/compact'):", s.includes("execute(sessionId, '/compact')"))
console.log('bytes:', Buffer.byteLength(s, 'utf8'))
try {
  new Function(s)
  console.log('syntax: OK')
} catch (error) {
  console.log('syntax ERROR:', error.message)
}
