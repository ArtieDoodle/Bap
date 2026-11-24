// server.js - OpenAI to NVIDIA NIM API Proxy
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// NVIDIA NIM API configuration
const NIM_API_BASE = process.env.NIM_API_BASE || 'https://nvidia.com';
const NIM_API_KEY = process.env.NIM_API_KEY;

// REASONING DISPLAY TOGGLE - Shows/hides reasoning in output
const SHOW_REASONING = false;

// THINKING MODE TOGGLE - Enables thinking for specific models that support it
const ENABLE_THINKING_MODE = false;

// Model mapping (adjust based on available NIM models)
const MODEL_MAPPING = {
  'kimi-k3.1-pro': 'moonshotai/kimi-k3.1-pro',
};

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'OpenAI to NVIDIA NIM Proxy',
    version: '1.0.1',
    endpoints: {
      health: '/health',
      models: '/v1/models',
      chat: '/v1/chat/completions'
    }
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'OpenAI to NVIDIA NIM Proxy', 
    reasoning_display: SHOW_REASONING,
    thinking_mode: ENABLE_THINKING_MODE,
    nim_api_configured: !!NIM_API_KEY
  });
});

// List models endpoint (OpenAI compatible)
app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(model => ({
    id: model,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'nvidia-nim-proxy'
  }));
  
  res.json({
    object: 'list',
    data: models
  });
});

// Chat completions endpoint (main proxy)
app.post('/v1/chat/completions', async (req, res) => {
  console.log('Received chat completion request');
  console.log('Body:', JSON.stringify(req.body, null, 2));
  
  try {
    // Validate API key
    if (!NIM_API_KEY) {
      console.error('NIM_API_KEY not configured');
      return res.status(500).json({
        error: {
          message: 'NVIDIA API key not configured',
          type: 'invalid_request_error',
          code: 500
        }
      });
    }

    const { model, messages, temperature, max_tokens, stream } = req.body;
    
    // Validate required fields
    if (!model || !messages) {
      return res.status(400).json({
        error: {
          message: 'Missing required fields: model and messages are required',
          type: 'invalid_request_error',
          code: 400
        }
      });
    }

    // Intercept Saucepan's connection "ping" test and reply instantly
    const isPingTest =
      max_tokens === 1 &&
      Array.isArray(messages) &&
      messages.length === 1 &&
      messages[0]?.content === 'ping';

    if (isPingTest) {
      console.log('Intercepted Saucepan ping test -> sending instant pong');
      return res.json({
        id: `chatcmpl-ping-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'pong'
            },
            finish_reason: 'stop'
          }
        ],
        usage: {
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 2
        }
      });
    }
    
    // Smart model selection with fallback
    let nimModel = MODEL_MAPPING[model];
    console.log(`Model mapping: ${model} -> ${nimModel || 'trying fallback'}`);
    
    if (!nimModel) {
      try {
        const testResponse = await axios.post(`${NIM_API_BASE}/chat/completions`, {
          model: model,
          messages: [{ role: 'user', content: 'test' }],
          max_tokens: 1
        }, {
          headers: { 
            'Authorization': `Bearer ${NIM_API_KEY}`, 
            'Content-Type': 'application/json' 
          },
          timeout: 15000,
          validateStatus: (status) => status < 500
        });
        
        if (testResponse.status >= 200 && testResponse.status < 300) {
          nimModel = model;
          console.log(`Model ${model} is directly supported by NIM`);
        }
      } catch (e) {
        console.log('Model test failed, using fallback logic');
      }
      
      if (!nimModel) {
        const modelLower = model.toLowerCase();
        if (modelLower.includes('gpt-4') || modelLower.includes('claude-opus') || modelLower.includes('405b')) {
          nimModel = 'meta/llama-3.1-405b-instruct';
        } else if (modelLower.includes('claude') || modelLower.includes('gemini') || modelLower.includes('70b')) {
          nimModel = 'meta/llama-3.1-70b-instruct';
        } else {
          nimModel = 'meta/llama-3.1-8b-instruct';
        }
        console.log(`Using fallback model: ${nimModel}`);
      }
    }
    
    // Transform OpenAI request to NIM format
    const nimRequest = {
      model: nimModel,
      messages: messages,
      temperature: temperature !== undefined ? temperature : 0.6,
      max_tokens: max_tokens || 9024,
      stream: stream || false
    };

    if (ENABLE_THINKING_MODE) {
      nimRequest.extra_body = { chat_template_kwargs: { thinking: true } };
    }
    
    console.log('Sending request to NVIDIA NIM:', JSON.stringify(nimRequest, null, 2));
    
    // Added explicit timeout so Axios doesn't hang forever
    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: stream ? 'stream' : 'json',
      timeout: 120000,
      validateStatus: () => true
    });
    
    // Check for errors
    if (response.status >= 400) {
      console.error('NVIDIA API error:', response.status, response.data);
      return res.status(response.status).json({
        error: {
          message: response.data?.error?.message || 'NVIDIA API request failed',
          type: 'invalid_request_error',
          code: response.status
        }
      });
    }
    
    if (stream) {
      // Disable proxy buffering on Render for smooth SSE streaming
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      
      let buffer = '';
      let reasoningStarted = false;
      
      response.data.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        
        lines.forEach(line => {
          if (line.startsWith('data: ')) {
            if (line.includes('[DONE]')) {
              res.write(line + '\n\n');
              return;
            }
            
            try {
              const data = JSON.parse(line.slice(6));
              if (data.choices?.[0]?.delta) {
                const reasoning = data.choices[0].delta.reasoning_content;
                const content = data.choices[0].delta.content;
                
                if (SHOW_REASONING) {
                  let combinedContent = '';
                  
                  if (reasoning && !reasoningStarted) {
                    combinedContent = '<think>\n' + reasoning;
                    reasoningStarted = true;
                  } else if (reasoning) {
                    combinedContent = reasoning;
                  }
                  
                  if (content && reasoningStarted) {
                    combinedContent += '</think>\n\n' + content;
                    reasoningStarted = false;
                  } else if (content) {
                    combinedContent += content;
                  }
                  
                  if (combinedContent) {
                    data.choices[0].delta.content = combinedContent;
                    delete data.choices[0].delta.reasoning_content;
                  }
                } else {
                  data.choices[0].delta.content = content || '';
                  delete data.choices[0].delta.reasoning_content;
                }
              }
              res.write(`data: ${JSON.stringify(data)}\n\n`);
            } catch (e) {
              console.error('Error parsing stream chunk:', e);
              res.write(line + '\n\n');
            }
          }
        });
      });
      
      response.data.on('end', () => {
        console.log('Stream ended');
        res.end();
      });
      
      response.data.on('error', (err) => {
        console.error('Stream error:', err);
        res.end();
      });
    } else {
      console.log('Received response from NVIDIA NIM');
      
      const choice = response.data.choices?.[0];
      let content = choice?.message?.content || '';
      const reasoning = choice?.message?.reasoning_content;

      if (SHOW_REASONING && reasoning) {
        content = `<think>\n${reasoning}\n</think>\n\n${content}`;
      }

      const openaiResponse = {
        id: response.data.id || `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: response.data.created || Math.floor(Date.now() / 1000),
        model: model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: content
            },
            finish_reason: choice?.finish_reason || 'stop'
          }
        ],
        usage: response.data.usage || {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0
        }
      };

      console.log('Sending response to client');
      res.json(openaiResponse);
    }
  } catch (error) {
    console.error('Proxy error:', error.message);
    res.status(500).json({
      error: {
    message: error.message || 'Internal proxy error',
    type: 'proxy_error',
    code: 500
  }
});
}
});

app.listen(PORT, () => {
  console.log("OpenAI to NVIDIA NIM Proxy running on port " + PORT);
});
