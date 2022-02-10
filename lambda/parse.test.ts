import { CloudWatchLogsDecodedData } from 'aws-lambda'
import { parseLambdaProps, parseMessage, toDocs } from './parse'

describe('parseLambdaProps', () => {
  it('should handle REPORT message', () => {
    const message =
      'REPORT RequestId: f140eb5e-809d-43dd-b93a-439b218c1873	Duration: 998.63 ms	Billed Duration: 1000 ms Memory Size: 128 MB	Max Memory Used: 38 MB'
    const [props, remainingMessage] = parseLambdaProps(message)

    expect(props.duration).toBe(998)
    expect(props.memoryUsed).toBe(38)
    expect(props.memorySize).toBe(128)
    expect(props.reqid).toEqual('f140eb5e') // f140eb5e-809d-43dd-b93a-439b218c1873
    expect(remainingMessage).toEqual(
      'Duration: 998.63 ms	Billed Duration: 1000 ms Memory Size: 128 MB	Max Memory Used: 38 MB'
    )
  })

  it('should ignore and swallow START message', () => {
    const [props, remainingMessage] = parseLambdaProps(
      'START RequestId: bf155fd9-a3d2-4001-be3b-e69afc5816c8 Version: $LATEST'
    )
    expect(props).toEqual({})
    expect(remainingMessage).toEqual('')
  })

  it('should ignore and swallow END message', () => {
    const [props, remainingMessage] = parseLambdaProps(
      'END RequestId: bf155fd9-a3d2-4001-be3b-e69afc5816c8'
    )
    expect(props).toEqual({})
    expect(remainingMessage).toEqual('')
  })

  it('should extract {timestamp, reqid, level} and remaining message from lambda console.log', () => {
    const [props, remainingMessage] = parseLambdaProps(
      '2019-03-01T10:10:07.227Z\t75f445ce-bf71-4bdf-9826-0e3817425752\tINFO Elasticsearch processed a batch of 1 items in 3ms'
    )
    expect(props['@timestamp']).toEqual('2019-03-01T10:10:07.227Z')
    expect(props.reqid).toEqual('75f445ce-bf71-4bdf-9826-0e3817425752')
    expect(props.level).toEqual('info')
    expect(remainingMessage).toEqual('Elasticsearch processed a batch of 1 items in 3ms')
  })

  it.each([
    ['DEBUG', 'debug'],
    ['INFO', 'info'],
    ['WARN', 'warn'],
    ['ERROR', 'error'],
  ])('should extract %s as log level "%s"', (prefix: string, expectedLevel: string) => {
    const [props] = parseLambdaProps(
      `2019-03-01T10:10:07.227Z	75f445ce-bf71-4bdf-9826-0e3817425752	${prefix} some message`
    )
    expect(props.level).toEqual(expectedLevel)
  })

  it('should handle uncaught exception with missing fields', () => {
    const uncaughtException = `2019-11-04T11:18:12.695Z undefined ERROR Uncaught Exception
  {
      "errorType": "Runtime.ImportModuleError",
      "errorMessage": "Error: Cannot find module 'aws-xray-sdk'",
      "stack": [
          "Runtime.ImportModuleError: Error: Cannot find module 'aws-xray-sdk'",
          "    at _loadUserApp (/var/runtime/UserFunction.js:100:13)"
      ]
  }`
    const [props, remainingMessage] = parseLambdaProps(uncaughtException)
    expect(props.level).toEqual('error')
    expect(props.reqid).toEqual('undefined')
    expect(remainingMessage).toEqual(`Uncaught Exception
  {
      "errorType": "Runtime.ImportModuleError",
      "errorMessage": "Error: Cannot find module 'aws-xray-sdk'",
      "stack": [
          "Runtime.ImportModuleError: Error: Cannot find module 'aws-xray-sdk'",
          "    at _loadUserApp (/var/runtime/UserFunction.js:100:13)"
      ]
  }`)
  })

  it('should return message if it is not a lambda console.log', () => {
    const [props, remainingMessage] = parseLambdaProps(
      '{\n"level": "info","msg": "some message"\n}'
    )

    expect(remainingMessage).toEqual('{\n"level": "info","msg": "some message"\n}')
  })
})

describe('parseMessage', () => {
  it('should extract props from lambda invoke error', () => {
    const invokeError = `Invoke Error
    {
        "errorType": "Error",
        "errorMessage": "some error message",
        "stack": [
            "Error: some error message",
            "    at _homogeneousError (/var/runtime/CallbackContext.js:13:12)",
            "    at Runtime.fail [as handler] (/var/task/webpack:/save-data/src/index.ts:22:13)"
        ]
    }`
    const parsed = parseMessage(invokeError)
    expect(parsed.level).toEqual('error')
    expect(parsed.msg).toEqual('Invoke Error - some error message')
    expect(parsed.stack).toEqual(
      'Error: some error message\n    at _homogeneousError (/var/runtime/CallbackContext.js:13:12)\n    at Runtime.fail [as handler] (/var/task/webpack:/save-data/src/index.ts:22:13)'
    )
  })

  it('should parse json', () => {
    const parsed = parseMessage('{"level": "info","duration": 123,"msg": "some message"}')
    expect(parsed).toEqual({ level: 'info', duration: 123, msg: 'some message' })
  })

  it('should not duplicate message before embedded json without msg field', () => {
    const parsed = parseMessage('message {"operation":"index"}')
    expect(parsed.msg).toBe('message')
  })

  it('should merge msg prop', () => {
    const parsed = parseMessage(
      'some message {"level":"warn", "field1": 1, "msg": "second message"}'
    )
    expect(parsed.msg).toEqual('some message - second message')
    expect(parsed.level).toEqual('warn')
    expect(parsed.field1).toEqual(1)
  })

  it('should not add "-" to msg if no msgs are merged', () => {
    const parsed: any = parseMessage('{"msg": "some message"}')
    expect(parsed.msg).toEqual('some message')
  })

  it('should log original message if message contains curly braces but no valid json', () => {
    const parsed = parseMessage('some { curly braces }')
    expect(parsed.msg).toEqual('some { curly braces }')
  })

  it('should add timestamp for time property', () => {
    const parsed = parseMessage('{"msg":"some message","time":1234567890123}')
    expect(parsed).toEqual({
      '@timestamp': '2009-02-13T23:31:30.123Z',
      msg: 'some message',
    })
  })

  it('should use stack and message from err property', () => {
    const message = {
      err: {
        type: 'Error',
        message: 'error message',
        stack: 'Error: error message\n    at handler (/app/bla.js:42:21)',
      },
      msg: 'message',
    }
    const parsed = parseMessage(JSON.stringify(message))

    expect(parsed.msg).toEqual('message - error message')
    expect(parsed.stack).toEqual(message.err.stack)
  })
})

describe('toDoc', () => {
  const fakeDecodedLambdaData = (...messages: string[]) => {
    return {
      logGroup: '/aws/lambda/some-app-dev',
      logStream: '2022/05/08/ab42b6',
      logEvents: messages.map((message, i) => ({ timestamp: 1234567890123 + i * 1000, message })),
    } as CloudWatchLogsDecodedData
  }

  it('should use ingest time for @timestamp if no timestamp is present in message', () => {
    const data = fakeDecodedLambdaData(`{"level":"info","msg":"some info message"}`)
    const docs = toDocs(data)
    expect(docs[0]['@timestamp']).toEqual('2009-02-13T23:31:30.123Z')
  })

  it('should use time field for @timestamp', () => {
    const data = fakeDecodedLambdaData(
      '{"level":"info","time":1234567890000,"msg":"some info message"}'
    )
    const docs = toDocs(data)
    expect(docs[0]['@timestamp']).toEqual('2009-02-13T23:31:30.000Z')
  })

  it('should use lambda time field for @timestamp', () => {
    const data = fakeDecodedLambdaData(
      '2019-03-01T10:10:07.227Z\t75f445ce-bf71-4bdf-9826-0e3817425752\tINFO message'
    )
    const docs = toDocs(data)
    expect(docs[0]['@timestamp']).toEqual('2019-03-01T10:10:07.227Z')
  })

  it('should process multiple messages', () => {
    const data = fakeDecodedLambdaData(
      'START RequestId: 8125c1fd-6f0f-4b2f-8ff0-b6b94a01f325 Version: $LATEST',
      'END RequestId: 8125c1fd-6f0f-4b2f-8ff0-b6b94a01f325',
      'REPORT RequestId: 8125c1fd-6f0f-4b2f-8ff0-b6b94a01f325\tDuration: 1457.70 ms\tBilled Duration: 1458 ms\tMemory Size: 128 MB\tMax Memory Used: 71 MB\tInit Duration: 293.13 ms'
    )
    const docs = toDocs(data)
    expect(docs).toEqual([
      {
        '@timestamp': '2009-02-13T23:31:30.123Z',
        app: 'some-app',
        env: 'dev',
        level: 'info',
        msg: '',
      },
      {
        '@timestamp': '2009-02-13T23:31:31.123Z',
        app: 'some-app',
        env: 'dev',
        level: 'info',
        msg: '',
      },
      {
        '@timestamp': '2009-02-13T23:31:32.123Z',
        app: 'some-app',
        duration: 1457,
        env: 'dev',
        level: 'lambda',
        memorySize: 128,
        memoryUsed: 71,
        msg: 'Duration: 1457.70 ms\tBilled Duration: 1458 ms\tMemory Size: 128 MB\tMax Memory Used: 71 MB\tInit Duration: 293.13 ms',
        reqid: '8125c1fd',
      },
    ])
  })
})
