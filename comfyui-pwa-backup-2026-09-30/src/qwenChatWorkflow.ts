import type { WorkflowPrompt } from './comfyClient'

const MODEL_NAME = 'Qwen3.5-4B-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf'
const MMPROJ_NAME = 'mmproj-Qwen3.5-4B-Uncensored-HauhauCS-Aggressive-BF16.gguf'
const CHAT_STATE_UID = 42001

export interface QwenChatWorkflowInputs {
  prompt: string
  imageName?: string
  seed?: number
  systemPrompt?: string
}

export function buildQwenChatWorkflow(inputs: QwenChatWorkflowInputs): WorkflowPrompt {
  const workflow: WorkflowPrompt = {
    '1': {
      inputs: {
        model: MODEL_NAME,
        mmproj: MMPROJ_NAME,
        chat_handler: 'Qwen3.5',
        n_ctx: 8192,
        vram_limit: -1,
        image_min_tokens: 0,
        image_max_tokens: 0,
        auto_offload: true,
        offload_threshold: 2,
      },
      class_type: 'llama_cpp_model_loader',
      _meta: { title: 'Qwen3.5 Hauhau Model' },
    },
    '2': {
      inputs: {
        llama_model: ['1', 0],
        parameters: ['3', 0],
        images: inputs.imageName ? undefined : undefined,
        preset_prompt: 'Empty - Nothing',
        custom_prompt: inputs.prompt,
        system_prompt: inputs.systemPrompt ?? '',
        inference_mode: 'one by one',
        max_frames: 24,
        max_size: 256,
        seed: inputs.seed ?? Math.floor(Math.random() * Number.MAX_SAFE_INTEGER),
        force_offload: false,
        save_states: true,
        image_1: inputs.imageName ? ['4', 0] : undefined,
      },
      class_type: 'llama_cpp_instruct_adv',
      _meta: { title: 'Qwen3.5 Chat' },
    },
    '3': {
      inputs: {
        max_tokens: 768,
        top_k: 20,
        top_p: 0.8,
        min_p: 0.05,
        typical_p: 1,
        temperature: 0.7,
        repeat_penalty: 1,
        frequency_penalty: 0,
        presence_penalty: 0,
        mirostat_mode: 0,
        mirostat_eta: 0.1,
        mirostat_tau: 5,
        state_uid: CHAT_STATE_UID,
      },
      class_type: 'llama_cpp_parameters',
      _meta: { title: 'Qwen Chat Parameters' },
    },
    '5': {
      inputs: {
        source: ['2', 0],
      },
      class_type: 'PreviewAny',
      _meta: { title: 'Qwen Chat Output' },
    },
  }

  if (inputs.imageName) {
    workflow['4'] = {
      inputs: { image: inputs.imageName },
      class_type: 'LoadImage',
      _meta: { title: 'Chat Image' },
    }
  }

  const instructInputs = workflow['2'].inputs
  for (const key of Object.keys(instructInputs)) {
    if (instructInputs[key] === undefined) delete instructInputs[key]
  }

  return workflow
}
