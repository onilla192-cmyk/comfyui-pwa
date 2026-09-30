import type { WorkflowPrompt } from './comfyClient'

const BASE_WORKFLOW: WorkflowPrompt = {
  "13": {"inputs":{"aspect_ratio":"1:1 (Square)","megapixels":0.5,"multiple":32},"class_type":"ResolutionSelector","_meta":{"title":"Resolution Selector"}},
  "461": {"inputs":{"filename_prefix":"Qwen_image_2.1","format":"png","format.bit_depth":"8-bit","format.input_color_space":"sRGB","images":["459:457",0]},"class_type":"SaveImageAdvanced","_meta":{"title":"Save Image (Advanced)"}},
  "470": {"inputs":{"image":"quality_restoration_20251228195625782.jpg"},"class_type":"LoadImage","_meta":{"title":"Load Image"}},
  "480": {"inputs":{"image":"G9DNyhOaMAATHBX.jpg"},"class_type":"LoadImage","_meta":{"title":"Load Image"}},
  "481": {"inputs":{"upscale_method":"area","largest_size":720,"image":["470",0]},"class_type":"ImageScaleToMaxDimension","_meta":{"title":"Scale Image to Max Dimension"}},
  "482": {"inputs":{"upscale_method":"area","largest_size":720,"image":["480",0]},"class_type":"ImageScaleToMaxDimension","_meta":{"title":"Scale Image to Max Dimension"}},
  "459:451": {"inputs":{"unet_name":"qwen_image_2.1_int8_convrot.safetensors","weight_dtype":"default"},"class_type":"UNETLoader","_meta":{"title":"Load Diffusion Model"}},
  "459:453": {"inputs":{"clip_name":"qwen3vl_8b_int8_convrot.safetensors","type":"qwen_image","device":"default"},"class_type":"CLIPLoader","_meta":{"title":"Load CLIP"}},
  "459:454": {"inputs":{"vae_name":"qwen_image_2.1_vae_bf16.safetensors"},"class_type":"VAELoader","_meta":{"title":"Load VAE"}},
  "459:456": {"inputs":{"width":["13",0],"height":["13",1],"batch_size":1},"class_type":"EmptyLatentImage","_meta":{"title":"Empty Latent Image"}},
  "459:457": {"inputs":{"samples":["459:458",0],"vae":["459:454",0]},"class_type":"VAEDecode","_meta":{"title":"VAE Decode"}},
  "459:458": {"inputs":{"seed":433120969218359,"steps":30,"cfg":2.5,"sampler_name":"euler","scheduler":"normal","denoise":1,"model":["459:469",0],"positive":["459:474",0],"negative":["459:474",1],"latent_image":["459:468",0]},"class_type":"KSampler","_meta":{"title":"KSampler"}},
  "459:468": {"inputs":{"switch":true,"on_false":["459:474",2],"on_true":["459:456",0]},"class_type":"ComfySwitchNode","_meta":{"title":"If/Else Switch"}},
  "459:469": {"inputs":{"device":"cpu","dtype":"int8","model":["459:451",0]},"class_type":"QwenImage21Cache","_meta":{"title":"Qwen Image 2.1 Cache"}},
  "459:474": {"inputs":{"prompt":"Using the provided man and woman character images, place both characters together naturally in the same room. Combine the two provided character images into one coherent scene inside the same room.\n\nIMPORTANT:\n\n* Preserve both characters exactly as they appear in their original source images.\n* Do NOT redraw, redesign, restyle, regenerate, or reinterpret either character.\n* Keep their faces, hairstyles, clothing, body proportions, colors, accessories, and original art style unchanged.\n* Treat both characters as locked, untouchable assets.\n* Do not merge, alter, or replace any character features.","negative_prompt":"avoid duplicated body parts, extra hands, extra arms, distorted body parts, extra fingers, abnormal body generation, blurriness, low quality, watermarks","resolution":0,"clip":["459:453",0],"images.image_1":["481",0],"vae":["459:454",0],"images.image_2":["482",0]},"class_type":"TextEncodeQwenImage21","_meta":{"title":"Text Encode Qwen Image 2.1"}}
}

export interface WorkflowInputs {
  prompt: string
  negativePrompt?: string
  seed?: number
  image1?: string
  image2?: string
  cfg?: number
  steps?: number
  scheduler?: string
  aspectRatio?: string
  megapixels?: number
  maxDimension?: number
  unetName?: string
  clipName?: string
  vaeName?: string
  upscaleMethod?: string
}

export function buildWorkflow(inputs: WorkflowInputs): WorkflowPrompt {
  const workflow: WorkflowPrompt = JSON.parse(JSON.stringify(BASE_WORKFLOW))
  workflow['459:474'].inputs.prompt = inputs.prompt
  if (inputs.unetName) workflow['459:451'].inputs.unet_name = inputs.unetName
  if (inputs.clipName) workflow['459:453'].inputs.clip_name = inputs.clipName
  if (inputs.vaeName) workflow['459:454'].inputs.vae_name = inputs.vaeName
  if (inputs.negativePrompt !== undefined) workflow['459:474'].inputs.negative_prompt = inputs.negativePrompt
  if (inputs.image1) {
    workflow['470'].inputs.image = inputs.image1
    workflow['459:474'].inputs['images.image_1'] = ['481', 0]
  } else {
    delete workflow['459:474'].inputs['images.image_1']
  }
  if (inputs.image2) {
    workflow['480'].inputs.image = inputs.image2
    workflow['459:474'].inputs['images.image_2'] = ['482', 0]
  } else {
    delete workflow['459:474'].inputs['images.image_2']
  }
  if (inputs.seed !== undefined) workflow['459:458'].inputs.seed = inputs.seed
  if (inputs.cfg !== undefined) workflow['459:458'].inputs.cfg = inputs.cfg
  if (inputs.steps !== undefined) workflow['459:458'].inputs.steps = inputs.steps
  if (inputs.scheduler !== undefined) workflow['459:458'].inputs.scheduler = inputs.scheduler
  if (inputs.aspectRatio !== undefined) {
    const aspectRatioAliases: Record<string, string> = {
      '1:1': '1:1 (Square)',
      '1:1 (Square)': '1:1 (Square)',
      '2:3': '2:3 (Portrait Photo)',
      '2:3 (Portrait Photo)': '2:3 (Portrait Photo)',
      '3:2': '3:2 (Photo)',
      '3:2 (Photo)': '3:2 (Photo)',
      '3:4': '3:4 (Portrait Standard)',
      '3:4 (Portrait Standard)': '3:4 (Portrait Standard)',
      '4:3': '4:3 (Standard)',
      '4:3 (Standard)': '4:3 (Standard)',
      '9:16': '9:16 (Portrait Widescreen)',
      '9:16 (Portrait Widescreen)': '9:16 (Portrait Widescreen)',
      '16:9': '16:9 (Widescreen)',
      '16:9 (Widescreen)': '16:9 (Widescreen)',
      '21:9': '21:9 (Ultrawide)',
      '21:9 (Ultrawide)': '21:9 (Ultrawide)',
    }
    workflow['13'].inputs.aspect_ratio = aspectRatioAliases[inputs.aspectRatio] || inputs.aspectRatio
  }
  if (inputs.upscaleMethod) {
    workflow['481'].inputs.upscale_method = inputs.upscaleMethod
    workflow['482'].inputs.upscale_method = inputs.upscaleMethod
  }
  if (inputs.maxDimension !== undefined) {
    // Make Max Dimension authoritative for the generated output as well as the
    // reference-image Scale Image to Max Dimension nodes. ResolutionSelector
    // takes megapixels + aspect ratio, so derive the target area from the
    // requested longest side instead of leaving output size controlled by the
    // separate megapixels setting.
    const ratioText = (inputs.aspectRatio || '1:1').split(' ')[0]
    const [ratioWidth, ratioHeight] = ratioText.split(':').map(Number)
    if (Number.isFinite(ratioWidth) && Number.isFinite(ratioHeight) && ratioWidth > 0 && ratioHeight > 0) {
      const ratioScale = Math.min(ratioWidth, ratioHeight) / Math.max(ratioWidth, ratioHeight)
      workflow['13'].inputs.megapixels = (inputs.maxDimension * inputs.maxDimension * ratioScale) / 1_000_000
    } else if (inputs.megapixels !== undefined) {
      workflow['13'].inputs.megapixels = inputs.megapixels
    }
    workflow['481'].inputs.largest_size = inputs.maxDimension
    workflow['482'].inputs.largest_size = inputs.maxDimension
  } else if (inputs.megapixels !== undefined) {
    workflow['13'].inputs.megapixels = inputs.megapixels
  }
  return workflow
}
