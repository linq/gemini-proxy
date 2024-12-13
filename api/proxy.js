// 在文件顶部添加调试标志
const DEBUG = process.env.DEBUG === 'true';

export default async function handler(req, res) {
  // 设置 CORS 头
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400'); // 24小时

  // 处理 OPTIONS 请求
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 只允许 POST 请求
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // 从 Authorization header 获取 API key
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const apiKey = authHeader.split(' ')[1];
    if (!apiKey) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    const openAIRequest = req.body;
    const isStreamRequest = openAIRequest.stream === true;

    // 从请求体获取模型名称，默认使用 gemini-pro
    const model = openAIRequest.model?.includes('gemini') ? 
      openAIRequest.model : 'gemini-pro';

    // 构建目标 URL
    const baseUrl = 'https://generativelanguage.googleapis.com/v1beta/models';
    const endpoint = isStreamRequest ? 'streamGenerateContent' : 'generateContent';
    const googleUrl = new URL(`${baseUrl}/${model}:${endpoint}`);
    googleUrl.searchParams.set('key', apiKey);
    
    // 如果是流式请求，添加 SSE 参数
    if (isStreamRequest) {
      googleUrl.searchParams.set('alt', 'sse');
    }

    // 转换请求格式
    const googleRequest = convertOpenAIToGoogle(openAIRequest);
    
    // 添加调试日志
    if (DEBUG) {
      console.log('OpenAI Request:', JSON.stringify(openAIRequest, null, 2));
      console.log('Google Request:', JSON.stringify(googleRequest, null, 2));
    }

    // 发送请求到 Google API
    const response = await fetch(googleUrl.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(googleRequest),
    });

    if (!response.ok) {
      const errorData = await response.json();
      if (DEBUG) {
        console.log('Google API Error:', JSON.stringify(errorData, null, 2));
      }
      return res.status(response.status).json({
        error: {
          message: errorData.error?.message || 'Google API error',
          type: 'google_api_error',
          code: response.status
        }
      });
    }

    // 处理流式响应
    if (isStreamRequest) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const decoder = new TextDecoder();
      let partialLine = '';
      let buffer = ''; // 添加buffer来累积数据

      try {
        const reader = response.body.getReader();

        while (true) {
          const { done, value } = await reader.read();
          
          if (done) {
            if (buffer) {
              processLine(buffer);
            }
            res.write('data: [DONE]\n\n');
            break;
          }

          const chunk = decoder.decode(value, { stream: true });
          buffer += chunk;

          // 查找完整的数据行
          let newlineIndex;
          while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newlineIndex);
            buffer = buffer.slice(newlineIndex + 1);
            if (line.trim()) {
              processLine(line);
            }
          }
        }
      } catch (e) {
        console.error('Stream processing error:', e);
      } finally {
        res.end();
      }
      return;

      // 处理单行数据的函数
      function processLine(line) {
        if (!line.trim() || !line.startsWith('data: ')) return;

        const data = line.slice(6);
        if (data === '[DONE]') {
          res.write('data: [DONE]\n\n');
          return;
        }

        try {
          // 添加调试日志
          if (DEBUG) {
            console.log('Processing line:', line);
          }
          
          const googleChunk = JSON.parse(data);
          const content = googleChunk.candidates?.[0]?.content?.parts?.[0]?.text;
          
          if (content) {
            const openAIChunk = {
              id: 'chatcmpl-' + Date.now(),
              object: 'chat.completion.chunk',
              created: Date.now()/1000,
              model: model,
              choices: [{
                index: 0,
                delta: {
                  content: content
                },
                finish_reason: null
              }]
            };

            res.write(`data: ${JSON.stringify(openAIChunk)}\n\n`);
          }
        } catch (e) {
          // 错误日志始终保留，但增加更多细节
          console.error('Parse error:', e.message);
          if (DEBUG) {
            console.error('Parse error for line:', line);
            console.error('Parse error details:', e);
          }
        }
      }
    }

    // 非流式响应处理
    const googleResponse = await response.json();
    if (DEBUG) {
      console.log('Google Response:', JSON.stringify(googleResponse, null, 2));
    }
    const openAIResponse = convertGoogleToOpenAI(googleResponse, model);
    
    res.setHeader('Content-Type', 'application/json');
    return res.status(response.status).json(openAIResponse);

  } catch (error) {
    console.error('Proxy error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

function convertOpenAIToGoogle(openAIRequest) {
  // 提取消息内容
  const messages = openAIRequest.messages || [];
  const prompt = messages.map(msg => msg.content).join('\n');

  return {
    contents: [{
      parts: [{
        text: prompt
      }]
    }],
    generationConfig: {
      temperature: openAIRequest.temperature || 0.7,
    }
  };
}

function convertGoogleToOpenAI(googleResponse, model) {
  // 处理错误情况
  if (googleResponse.error) {
    return {
      error: {
        message: googleResponse.error.message,
        type: 'invalid_request_error',
        code: googleResponse.error.code
      }
    };
  }

  // 提取生成的内容
  const content = googleResponse.candidates?.[0]?.content;
  if (!content) {
    return {
      error: {
        message: 'No content generated',
        type: 'invalid_response_error'
      }
    };
  }

  // 构建 OpenAI 格式的响应
  return {
    id: 'chatcmpl-' + Date.now(),
    object: 'chat.completion',
    created: Date.now()/1000,
    model: model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: content.parts?.[0]?.text || ''
      },
      finish_reason: 'stop'
    }],
    usage: {
      prompt_tokens: -1,
      completion_tokens: -1,
      total_tokens: -1
    }
  };
}
