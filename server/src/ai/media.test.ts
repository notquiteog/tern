// Generating a picture or a video, without a picture or a video host.
//
// Everything worth checking here is a request that has not been sent and a
// reply that did not come from anywhere: which fields go out for which model,
// and which of half a dozen shapes a picture comes back in. That is the part
// that cannot be found by trying it — a wrong field is a 400 from a host an
// install is paying by the request, and a misread reply is a file with the
// right extension and the wrong bytes in it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildComfyGraph, comfyRefusal, comfySize, comfyWorkflowProblem, imageRequestBody, isValidSize,
  mediaDefaults, readComfyHistory, readImageReply, readVideoStatus, sniffMediaType, takesResponseFormat,
  type MediaSettings,
} from './media.js';

const settings = (over: Partial<MediaSettings> = {}): MediaSettings => ({
  ...mediaDefaults(), baseUrl: 'https://draw.example', imageModel: 'dall-e-3', ...over,
});

// ---------- ComfyUI ----------

const values = { prompt: 'a heron', negative: '', model: 'sd_xl_base_1.0.safetensors', width: 1024, height: 768, seed: 42 };

test('the built-in graph fills its tokens, with real numbers where numbers belong', () => {
  const g: any = buildComfyGraph('', values);
  assert.equal(g['4'].inputs.ckpt_name, 'sd_xl_base_1.0.safetensors');
  assert.equal(g['6'].inputs.text, 'a heron');
  // ComfyUI validates input types: the string "1024" for a width is refused.
  assert.equal(g['5'].inputs.width, 1024);
  assert.equal(g['5'].inputs.height, 768);
  assert.equal(g['3'].inputs.seed, 42);
  assert.ok(!JSON.stringify(g).includes('%'), 'a token survived into the graph that would be queued');
});

test('an admin’s workflow keeps its own nodes and fills tokens inside longer strings', () => {
  const wf = JSON.stringify({
    1: { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%, film grain' } },
    2: { class_type: 'KSampler', inputs: { seed: '%seed%', steps: 30, note: '%unknown%' } },
  });
  const g: any = buildComfyGraph(wf, { ...values, seed: 7 });
  assert.equal(g['1'].inputs.text, 'a heron, film grain');
  assert.equal(g['2'].inputs.seed, 7);
  assert.equal(g['2'].inputs.steps, 30);
  assert.equal(g['2'].inputs.note, '%unknown%', 'a token this does not know is left alone rather than blanked');
});

test('a size becomes latent dimensions, and nonsense falls back rather than failing', () => {
  assert.deepEqual(comfySize('1024x768'), [1024, 768]);
  assert.deepEqual(comfySize('1023x769'), [1016, 768]);
  assert.deepEqual(comfySize(''), [1024, 1024]);
});

test('a pasted workflow is refused when it could not run, and accepted when it could', () => {
  assert.equal(comfyWorkflowProblem(''), null, 'empty means the built-in graph');
  assert.match(comfyWorkflowProblem('{not json') ?? '', /not JSON/);
  assert.match(comfyWorkflowProblem(JSON.stringify({ nodes: [], links: [] })) ?? '', /layout/);
  assert.match(comfyWorkflowProblem(JSON.stringify({ 1: { class_type: 'KSampler', inputs: {} } })) ?? '', /%prompt%/);
  assert.equal(comfyWorkflowProblem(JSON.stringify({ 1: { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%' } } })), null);
});

test('a job is running until its history says otherwise, and a failure carries the node’s own reason', () => {
  assert.deepEqual(readComfyHistory(undefined), { state: 'running' });
  assert.deepEqual(
    readComfyHistory({ status: { status_str: 'success', completed: true }, outputs: { 9: { images: [{ filename: 'tern_0001.png', subfolder: '', type: 'output' }] } } }),
    { state: 'done', image: { filename: 'tern_0001.png', subfolder: '', type: 'output' } },
  );
  assert.deepEqual(
    readComfyHistory({ status: { status_str: 'error', completed: false, messages: [['execution_error', { exception_message: 'CUDA out of memory' }]] } }),
    { state: 'error', error: 'CUDA out of memory' },
  );
  assert.deepEqual(
    readComfyHistory({ status: { status_str: 'success', completed: true }, outputs: {} }),
    { state: 'done', image: null },
    'finished with no picture is not "still running" — that would poll until the deadline',
  );
});

test('a refused job says which node refused what', () => {
  const body = JSON.stringify({
    error: { message: 'Prompt outputs failed validation' },
    node_errors: { 4: { class_type: 'CheckpointLoaderSimple', errors: [{ message: 'Value not in list', details: "ckpt_name: 'nope.safetensors'" }] } },
  });
  assert.equal(comfyRefusal(body), "CheckpointLoaderSimple: Value not in list — ckpt_name: 'nope.safetensors'");
  assert.equal(comfyRefusal('plain text'), 'plain text');
});

// ---------- What goes out ----------

test('a picture is asked for as base64 wherever the model understands the question', () => {
  // Not a preference. A URL is a second request this server then has to make
  // to an address it did not choose, which is the whole reason `fetchLinked`
  // has a guard in front of it; base64 skips that entirely.
  const body = imageRequestBody(settings(), 'a heron on a jetty') as any;
  assert.equal(body.response_format, 'b64_json');
  assert.equal(body.prompt, 'a heron on a jetty');
  assert.equal(body.model, 'dall-e-3');
  assert.equal(body.n, 1);
  assert.equal(body.size, '1024x1024');
});

test('the models that refuse response_format are not sent it', () => {
  // `gpt-image-1` answers "Unknown parameter: response_format" and fails the
  // whole request — it returns base64 unconditionally and treats being asked
  // as an error. So the field is sent where it is understood and omitted
  // where it is not, rather than sent everywhere and hoped about.
  assert.equal(takesResponseFormat('gpt-image-1'), false);
  assert.equal(takesResponseFormat('openai/gpt-image-1'), false);
  assert.equal(takesResponseFormat('dall-e-3'), true);
  assert.equal(takesResponseFormat('black-forest-labs/FLUX.1-schnell'), true);

  const body = imageRequestBody(settings({ imageModel: 'gpt-image-1' }), 'a heron') as any;
  assert.ok(!('response_format' in body), 'gpt-image-1 was sent a parameter it refuses');
  assert.equal(body.prompt, 'a heron');
});

test('OpenRouter is not asked for base64, which is all its Image API ever sends', () => {
  const body = imageRequestBody(settings({ baseUrl: 'https://openrouter.ai/api/v1', imageModel: 'qwen/qwen-image-3' }), 'a heron') as any;
  assert.ok(!('response_format' in body), 'OpenRouter was sent a field its Image API does not have');
  assert.equal(body.model, 'qwen/qwen-image-3');
  assert.equal(body.size, '1024x1024');
});

test('an empty size is left out rather than sent empty', () => {
  // `size: ""` is not "the host decides", it is a value the host rejects.
  const body = imageRequestBody(settings({ imageSize: '' }), 'a heron') as any;
  assert.ok(!('size' in body));
});

test('the chat shape asks for a picture instead of a paragraph about one', () => {
  // `modalities` is the whole difference. Without it the same model on the
  // same endpoint writes prose describing the picture, which is a successful
  // request with nothing usable in it.
  const body = imageRequestBody(settings({ provider: 'openai-chat', imageModel: 'google/gemini-2.5-flash-image' }), 'a heron') as any;
  assert.deepEqual(body.modalities, ['image', 'text']);
  assert.deepEqual(body.messages, [{ role: 'user', content: 'a heron' }]);
  // The fields of the other shape must not come along: `prompt` and
  // `response_format` are not chat-completions fields and several hosts
  // refuse a body carrying them.
  assert.ok(!('prompt' in body), 'the chat shape was sent the other shape’s prompt field');
  assert.ok(!('response_format' in body));
  assert.ok(!('size' in body));
});

test('a size is a size', () => {
  for (const ok of ['', '1024x1024', '1792x1024', '512x512', '1280x720']) assert.equal(isValidSize(ok), true, ok);
  for (const bad of ['1024', '1024*1024', 'big', '0x0', '1024x1024; drop', '-1x5']) assert.equal(isValidSize(bad), false, bad);
});

// ---------- What comes back ----------

test('a picture is found in every shape a host sends one', () => {
  // Five spellings across two shapes, and a host is free to pick any of them.
  // Reading only the first is how a working connection produces "that host
  // answered without a picture in it" for ever.
  assert.deepEqual(readImageReply('openai', { data: [{ b64_json: 'AAAA' }] }), { b64: 'AAAA', revisedPrompt: undefined });
  assert.deepEqual(readImageReply('openai', { data: [{ url: 'https://cdn.example/x.png' }] }), { url: 'https://cdn.example/x.png', revisedPrompt: undefined });
  // A data URL on the `url` field, which several OpenAI-compatible servers do
  // rather than filling in b64_json. Following it as a link would fail.
  assert.deepEqual(readImageReply('openai', { data: [{ url: 'data:image/png;base64,BBBB' }] }), { b64: 'BBBB', revisedPrompt: undefined });
  // OpenRouter's dedicated array...
  assert.deepEqual(readImageReply('openai-chat', {
    choices: [{ message: { images: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,CCCC' } }] } }],
  }), { b64: 'CCCC' });
  // ...and an image part inside the content array, which Google's
  // compatibility layer uses instead.
  assert.deepEqual(readImageReply('openai-chat', {
    choices: [{ message: { content: [{ type: 'text', text: 'here you go' }, { type: 'image_url', image_url: { url: 'data:image/webp;base64,DDDD' } }] } }],
  }), { b64: 'DDDD' });
});

test('a reply with no picture in it is reported as one, not guessed at', () => {
  assert.equal(readImageReply('openai', { data: [] }), null);
  assert.equal(readImageReply('openai', {}), null);
  assert.equal(readImageReply('openai', { data: [{ b64_json: '' }] }), null);
  // The common real case: a chat model on the chat shape, which answers in
  // words. Storing that as a .png is the failure this returns null to avoid.
  assert.equal(readImageReply('openai-chat', { choices: [{ message: { content: 'A heron is a long-legged bird.' } }] }), null);
});

test('a host that rewrote the prompt has it carried back', () => {
  const r = readImageReply('openai', { data: [{ b64_json: 'AAAA', revised_prompt: 'a grey heron, photographic' }] });
  assert.equal(r?.revisedPrompt, 'a grey heron, photographic');
});

test('the file type is read from the bytes, never from the label', () => {
  // What decides whether the composer can show the picture at all: the upload
  // route serves a file inline only for a type it recognises and refuses to
  // sniff, so a host labelling a WebP as a PNG would otherwise produce an
  // attachment nobody can see.
  assert.equal(sniffMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])), 'image/jpeg');
  assert.equal(sniffMediaType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])), 'image/png');
  assert.equal(sniffMediaType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(4)])), 'image/webp');
  assert.equal(sniffMediaType(Buffer.from('GIF89a\0\0\0\0')), 'image/gif');
  assert.equal(sniffMediaType(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(4)])), 'video/mp4');
  assert.equal(sniffMediaType(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypqt  '), Buffer.alloc(4)])), 'video/quicktime');
  assert.equal(sniffMediaType(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0])), 'video/webm');
  // Anything else, including an error page a host sent with a 200 on it.
  assert.equal(sniffMediaType(Buffer.from('{"error":"quota"}')), null);
  assert.equal(sniffMediaType(Buffer.alloc(0)), null);
});

// ---------- The video job ----------

test('a generation is only called finished when the host says so', () => {
  for (const word of ['completed', 'succeeded', 'done', 'ready', 'SUCCESS']) {
    assert.equal(readVideoStatus({ status: word }).state, 'done', word);
  }
  for (const word of ['failed', 'error', 'cancelled', 'rejected']) {
    assert.equal(readVideoStatus({ status: word }).state, 'error', word);
  }
});

test('a word nobody here has seen means the job is still going, not that it broke', () => {
  // The asymmetry is the point. Treating an unrecognised status as a failure
  // throws away a generation somebody paid for because a host invented a new
  // word for "rendering"; treating it as still running costs one more poll.
  for (const word of ['queued', 'in_progress', 'rendering', 'preprocessing', '']) {
    assert.equal(readVideoStatus({ status: word }).state, 'running', word);
  }
  assert.equal(readVideoStatus(null).state, 'running');
  assert.equal(readVideoStatus({}).status, 'working');
});

test('progress is read whichever scale the host reports it on', () => {
  // Some hosts count to 100 and some to 1. Reading 0.5 as half a percent
  // leaves a bar that never moves.
  assert.equal(readVideoStatus({ status: 'in_progress', progress: 0.5 }).pct, 50);
  assert.equal(readVideoStatus({ status: 'in_progress', progress: 50 }).pct, 50);
  assert.equal(readVideoStatus({ status: 'in_progress', progress: 1 }).pct, 100);
  assert.equal(readVideoStatus({ status: 'in_progress' }).pct, null);
});

test('a failure carries the host’s own reason where there is one', () => {
  assert.equal(readVideoStatus({ status: 'failed', error: { message: 'content policy' } }).error, 'content policy');
  assert.equal(readVideoStatus({ status: 'failed', error: 'out of credit' }).error, 'out of credit');
  assert.match(readVideoStatus({ status: 'failed' }).error!, /failed/);
});

// ---------- What the defaults promise ----------

test('a fresh install has nowhere to send a prompt and says so', () => {
  const d = mediaDefaults();
  assert.equal(d.images, false);
  assert.equal(d.videos, false);
  assert.equal(d.baseUrl, '');
  // Off by default like every other connection here: an image host is
  // somebody else's machine, and a per-endpoint switch that defaulted to on
  // would route traffic through Tor for an install that never asked.
  assert.equal(d.useTor, false);
  assert.equal(d.videoUseTor, false);
  assert.equal(d.tlsInsecure, false);
  // Video shares the image connection until told otherwise, and sharing means
  // the whole connection — see the Tor suite for the half-inheritance bug
  // this default is arranged to avoid.
  assert.equal(d.videoProvider, 'same');
});
