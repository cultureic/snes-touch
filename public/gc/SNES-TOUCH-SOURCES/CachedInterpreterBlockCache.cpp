// Copyright 2024 Dolphin Emulator Project
// SPDX-License-Identifier: GPL-2.0-or-later

#include "Core/PowerPC/CachedInterpreter/CachedInterpreterBlockCache.h"

#include "Core/PowerPC/CachedInterpreter/CachedInterpreterEmitter.h"
#include "Core/PowerPC/JitCommon/JitBase.h"

#ifdef __EMSCRIPTEN__
// SNES Touch: defined in CachedInterpreter.cpp; drops a destroyed block from the wasm region.
void DolphinWeb_ForgetWasmRegionBlock(const u8* normal_entry);
#endif

CachedInterpreterBlockCache::CachedInterpreterBlockCache(JitBase& jit) : JitBaseBlockCache{jit}
{
}

void CachedInterpreterBlockCache::Init()
{
#if DOLPHIN_WEB_STATIC_EXIT_LINKS
  AdvanceStaticLinkEpoch();
#endif
#line 15
  JitBaseBlockCache::Init();
  ClearRangesToFree();
}

void CachedInterpreterBlockCache::DestroyBlock(JitBlock& block)
{
#ifdef __EMSCRIPTEN__
  DolphinWeb_ForgetWasmRegionBlock(block.normalEntry);
#endif
#if DOLPHIN_WEB_STATIC_EXIT_LINKS
  AdvanceStaticLinkEpoch();
#endif
#line 21
  JitBaseBlockCache::DestroyBlock(block);

  if (block.near_begin != block.near_end)
    m_ranges_to_free_on_next_codegen.emplace_back(block.near_begin, block.near_end);
}

void CachedInterpreterBlockCache::ClearRangesToFree()
{
  m_ranges_to_free_on_next_codegen.clear();
}

void CachedInterpreterBlockCache::WriteLinkBlock(const JitBlock::LinkData& source,
                                                 const JitBlock* dest)
{
#if DOLPHIN_WEB_STATIC_EXIT_LINKS
  StaticExitLinks::WriteEntry(reinterpret_cast<StaticExitLinks::Cell*>(source.exitPtrs),
                              dest ? dest->normalEntry : nullptr);
#endif
#line 35
}

void CachedInterpreterBlockCache::WriteDestroyBlock(const JitBlock& block)
{
  CachedInterpreterEmitter emitter(block.normalEntry, block.near_end);
  emitter.Write(CachedInterpreterEmitter::PoisonCallback);
}
