// C ABI around NAM Core for the browser. Built as a standalone .wasm (no
// Emscripten JS glue) so it can be instantiated inside AudioWorkletGlobalScope
// with a hand-written loader (web/worklets/nam-wasm.js) and in Node for tests.
//
// One module instance per NAM node: each AudioWorkletNode owns its memory.
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <string>

#include "NAM/dsp.h"
#include "NAM/get_dsp.h"
#include "json.hpp"

namespace
{
struct Handle
{
  std::unique_ptr<nam::DSP> dsp;
  int maxBlock = 128;
  float* in = nullptr;
  float* out = nullptr;
};
std::string gLastError;
} // namespace

extern "C" {

__attribute__((export_name("nam_malloc"))) void* nam_malloc(size_t n) { return std::malloc(n); }
__attribute__((export_name("nam_free"))) void nam_free(void* p) { std::free(p); }

__attribute__((export_name("nam_last_error"))) const char* nam_last_error() { return gLastError.c_str(); }

// Parse a .nam JSON document (UTF-8, not NUL-terminated) and build a model.
// Returns an opaque handle, or 0 on failure (see nam_last_error).
__attribute__((export_name("nam_create"))) Handle* nam_create(const char* json, int len, double sampleRate, int maxBlock)
{
  try
  {
    auto j = nlohmann::json::parse(json, json + len);
    auto dsp = nam::get_dsp(j);
    if (!dsp)
    {
      gLastError = "get_dsp returned null";
      return nullptr;
    }
    auto* h = new Handle();
    h->dsp = std::move(dsp);
    h->maxBlock = maxBlock;
    h->in = static_cast<float*>(std::calloc(maxBlock, sizeof(float)));
    h->out = static_cast<float*>(std::calloc(maxBlock, sizeof(float)));
    const double sr = sampleRate > 0 ? sampleRate : h->dsp->GetExpectedSampleRate();
    h->dsp->Reset(sr, maxBlock);
    gLastError.clear();
    return h;
  }
  catch (const std::exception& e)
  {
    gLastError = e.what();
  }
  catch (...)
  {
    gLastError = "unknown exception";
  }
  return nullptr;
}

__attribute__((export_name("nam_in_ptr"))) float* nam_in_ptr(Handle* h) { return h->in; }
__attribute__((export_name("nam_out_ptr"))) float* nam_out_ptr(Handle* h) { return h->out; }

// Process n <= maxBlock frames from h->in into h->out.
__attribute__((export_name("nam_process"))) void nam_process(Handle* h, int n)
{
#ifdef NAM_SAMPLE_FLOAT
  NAM_SAMPLE* ins[1] = {h->in};
  NAM_SAMPLE* outs[1] = {h->out};
  h->dsp->process(ins, outs, n);
#else
  static_assert(sizeof(NAM_SAMPLE) == sizeof(float), "build with -DNAM_SAMPLE_FLOAT");
#endif
}

__attribute__((export_name("nam_reset"))) void nam_reset(Handle* h, double sampleRate)
{
  h->dsp->Reset(sampleRate, h->maxBlock);
}

__attribute__((export_name("nam_expected_sample_rate"))) double nam_expected_sample_rate(Handle* h)
{
  return h->dsp->GetExpectedSampleRate();
}

// Loudness in dB of a "typical" input, or 1e9 if the model does not carry it.
__attribute__((export_name("nam_loudness"))) double nam_loudness(Handle* h)
{
  return h->dsp->HasLoudness() ? h->dsp->GetLoudness() : 1e9;
}

__attribute__((export_name("nam_destroy"))) void nam_destroy(Handle* h)
{
  if (!h)
    return;
  std::free(h->in);
  std::free(h->out);
  delete h;
}
}
