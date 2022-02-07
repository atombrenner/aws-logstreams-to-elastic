import { postToElastic } from '../lambda/elastic'
import { LogDoc } from '../lambda/parse'

const app = 'app'
const env = 'env'
const level = 'info'

const timestamp = new Date().toISOString()

async function main() {
  // index some documents
  const docs: LogDoc[] = [
    { '@timestamp': timestamp, app, env, level, msg: 'one' },
    { '@timestamp': timestamp, app, env, level, msg: 'two' },
    { '@timestamp': timestamp, app, env, level, msg: '' }, // with empty msg
    { '@timestamp': timestamp, app, env, level, msg: 'four' },
    { '@timestamp': timestamp, app, env, level, msg: 'five' },
    { '@timestamp': timestamp, app, env, level, msg: 'next day' },
  ]
  const result = await postToElastic(docs)
  console.log(result)
}

main().catch(console.error)
