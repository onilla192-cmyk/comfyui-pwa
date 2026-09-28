# RunPod remote generation

This branch adds a remote generation mode while preserving the existing local/Tailscale mode.

Set `VITE_GENERATION_MODE=remote` in the deployed frontend and set `RUNPOD_API_KEY` plus `RUNPOD_ENDPOINT_ID` as server-side environment variables.

The PWA submits the existing Qwen Image 2.1 INT8 ComfyUI API workflow asynchronously to RunPod Serverless and polls the job status. Source images are sent as base64 input images. The RunPod API key never reaches the phone.

The RunPod worker must contain the Qwen Image 2.1 INT8 models and the custom nodes used by `src/workflowTemplate.ts`.
