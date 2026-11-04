// Copyright 2014 Dolphin Emulator Project
// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

#include <cstddef>

#include "Common/CommonTypes.h"
#include "Common/RangeSizeSet.h"
#include "Core/PowerPC/CachedInterpreter/CachedInterpreterBlockCache.h"
#include "Core/PowerPC/CachedInterpreter/CachedInterpreterEmitter.h"
#include "Core/PowerPC/JitCommon/JitBase.h"
#include "Core/PowerPC/PPCAnalyst.h"

namespace CoreTiming
{
class CoreTimingManager;
}
namespace CPU
{
enum class State;
}
class Interpreter;

class CachedInterpreter : public JitBase, public CachedInterpreterCodeBlock
{
public:
  explicit CachedInterpreter(Core::System& system);
  CachedInterpreter(const CachedInterpreter&) = delete;
  CachedInterpreter(CachedInterpreter&&) = delete;
  CachedInterpreter& operator=(const CachedInterpreter&) = delete;
  CachedInterpreter& operator=(CachedInterpreter&&) = delete;
  ~CachedInterpreter() override;

  void Init() override;
  void Shutdown() override;

  bool HandleFault(uintptr_t access_address, SContext* ctx) override { return false; }
  void ClearCache() override;

  void Run() override;
  void SingleStep() override;

  void Jit(u32 address) override;
  void Jit(u32 address, bool clear_cache_and_retry_on_failure);
  bool DoJit(u32 address, JitBlock* b, u32 nextPC);

  void EraseSingleBlock(const JitBlock& block) override;
  std::vector<MemoryStats> GetMemoryStats() const override;

  static std::size_t Disassemble(const JitBlock& block, std::ostream& stream);

  std::size_t DisassembleNearCode(const JitBlock& block, std::ostream& stream) const override;
  std::size_t DisassembleFarCode(const JitBlock& block, std::ostream& stream) const override;

  JitBaseBlockCache* GetBlockCache() override { return &m_block_cache; }
  const char* GetName() const override { return "Cached Interpreter"; }
  const CommonAsmRoutinesBase* GetAsmRoutines() override { return nullptr; }

private:
  void ExecuteOneBlock(bool allow_redispatch = true);

  bool HandleFunctionHooking(u32 address);
#if DOLPHIN_WEB_STATIC_EXIT_LINKS
  void WriteEndBlock(StaticExitLinks::Descriptor links = {});
  void RegisterStaticExitLinks(StaticExitLinks::Descriptor* links);
  bool StaticExitLinksEnabled() const;
#else
#line 64
  void WriteEndBlock();
#endif
#line 65

  // Finds a free memory region and sets the code emitter to point at that region.
  // Returns false if no free memory region can be found.
  bool SetEmitterStateToFreeCodeRegion();

  void FreeRanges();
  void ResetFreeMemoryRanges();

  void LogGeneratedCode() const;
  bool TryWriteFastInstruction(const PPCAnalyst::CodeOp& op,
                               PowerPC::PowerPCManager& power_pc);
  bool TryWriteMeleeIdlePollLoop(u32 index, PowerPC::PowerPCManager& power_pc);
  bool TryWriteMeleeTitleLoop(u32 index, PowerPC::PowerPCManager& power_pc);
  bool TryWriteOsInterruptFunction(u32 index, PowerPC::PowerPCManager& power_pc);
  bool TryWriteDcbxLoop(u32 index, PowerPC::PowerPCManager& power_pc);

#ifdef __EMSCRIPTEN__
  bool TryWriteWasmBlock(u32 nextPC);
#endif

  struct StartProfiledBlockOperands;
  template <bool profiled>
  struct EndBlockOperands;
  struct InterpretOperands;
  struct InterpretAndCheckExceptionsOperands;
  struct FastInstructionOperands;
  struct FastBranchBdnzOperands;
  struct MeleeIdlePollLoopOperands;
  struct MeleeTitleLoopOperands;
  struct OsInterruptFunctionOperands;
  struct DcbxLoopOperands;
  struct HLEFunctionOperands;
  struct WriteBrokenBlockNPCOperands;
  struct CheckHaltOperands;
  struct CheckIdleOperands;
#ifdef __EMSCRIPTEN__
  struct WasmBlockOperands;
#endif

  static s32 StartProfiledBlock(PowerPC::PowerPCState& ppc_state,
                                const StartProfiledBlockOperands& operands);
  static s32 StartProfiledBlock(std::ostream& stream, const StartProfiledBlockOperands& operands);
  template <bool profiled>
  static s32 EndBlock(PowerPC::PowerPCState& ppc_state, const EndBlockOperands<profiled>& operands);
  template <bool profiled>
  static s32 EndBlock(std::ostream& stream, const EndBlockOperands<profiled>& operands);
  template <bool write_pc>
  static s32 Interpret(PowerPC::PowerPCState& ppc_state, const InterpretOperands& operands);
  template <bool write_pc>
  static s32 Interpret(std::ostream& stream, const InterpretOperands& operands);
  template <bool write_pc>
  static s32 InterpretAndCheckExceptions(PowerPC::PowerPCState& ppc_state,
                                         const InterpretAndCheckExceptionsOperands& operands);
  template <bool write_pc>
  static s32 InterpretAndCheckExceptions(std::ostream& stream,
                                         const InterpretAndCheckExceptionsOperands& operands);
  static s32 FastMfmsr(PowerPC::PowerPCState& ppc_state,
                       const FastInstructionOperands& operands);
  static s32 FastMfmsr(std::ostream& stream, const FastInstructionOperands& operands);
  static s32 FastMtmsr(PowerPC::PowerPCState& ppc_state,
                       const FastInstructionOperands& operands);
  static s32 FastMtmsr(std::ostream& stream, const FastInstructionOperands& operands);
  static s32 FastMfspr(PowerPC::PowerPCState& ppc_state,
                       const FastInstructionOperands& operands);
  static s32 FastMfspr(std::ostream& stream, const FastInstructionOperands& operands);
  static s32 FastMtspr(PowerPC::PowerPCState& ppc_state,
                       const FastInstructionOperands& operands);
  static s32 FastMtspr(std::ostream& stream, const FastInstructionOperands& operands);
  static s32 FastSystemNoop(PowerPC::PowerPCState& ppc_state,
                            const FastInstructionOperands& operands);
  static s32 FastSystemNoop(std::ostream& stream, const FastInstructionOperands& operands);
  static s32 FastInteger(PowerPC::PowerPCState& ppc_state,
                         const FastInstructionOperands& operands);
  static s32 FastInteger(std::ostream& stream, const FastInstructionOperands& operands);
  static s32 FastBranch(PowerPC::PowerPCState& ppc_state,
                        const FastInstructionOperands& operands);
  static s32 FastBranch(std::ostream& stream, const FastInstructionOperands& operands);
  static s32 FastBranchBdnz(PowerPC::PowerPCState& ppc_state,
                            const FastBranchBdnzOperands& operands);
  static s32 FastBranchBdnz(std::ostream& stream, const FastBranchBdnzOperands& operands);
  static s32 FastFloat(PowerPC::PowerPCState& ppc_state,
                       const FastInstructionOperands& operands);
  static s32 FastFloat(std::ostream& stream, const FastInstructionOperands& operands);
  static s32 FastMeleeIdlePollLoop(PowerPC::PowerPCState& ppc_state,
                                   const MeleeIdlePollLoopOperands& operands);
  static s32 FastMeleeIdlePollLoop(std::ostream& stream,
                                   const MeleeIdlePollLoopOperands& operands);
  static s32 FastMeleeTitleLoop(PowerPC::PowerPCState& ppc_state,
                                const MeleeTitleLoopOperands& operands);
  static s32 FastMeleeTitleLoop(std::ostream& stream, const MeleeTitleLoopOperands& operands);
  static s32 FastOsInterruptFunction(PowerPC::PowerPCState& ppc_state,
                                     const OsInterruptFunctionOperands& operands);
  static s32 FastOsInterruptFunction(std::ostream& stream,
                                     const OsInterruptFunctionOperands& operands);
  static s32 FastOsInterruptCallBranch(PowerPC::PowerPCState& ppc_state,
                                       const OsInterruptFunctionOperands& operands);
  static s32 FastOsInterruptCallBranch(std::ostream& stream,
                                       const OsInterruptFunctionOperands& operands);
  static s32 FastMeleeInputStatusCallBranch(PowerPC::PowerPCState& ppc_state,
                                            const FastInstructionOperands& operands);
  static s32 FastMeleeInputStatusCallBranch(std::ostream& stream,
                                            const FastInstructionOperands& operands);
  static s32 FastMeleeStatusFunctionCallBranch(PowerPC::PowerPCState& ppc_state,
                                               const FastInstructionOperands& operands);
  static s32 FastMeleeStatusFunctionCallBranch(std::ostream& stream,
                                               const FastInstructionOperands& operands);
  static s32 FastMeleeServicePollCallBranch(PowerPC::PowerPCState& ppc_state,
                                            const FastInstructionOperands& operands);
  static s32 FastMeleeServicePollCallBranch(std::ostream& stream,
                                            const FastInstructionOperands& operands);
  static s32 FastMeleeSiPollNoEventCallBranch(PowerPC::PowerPCState& ppc_state,
                                              const FastInstructionOperands& operands);
  static s32 FastMeleeSiPollNoEventCallBranch(std::ostream& stream,
                                              const FastInstructionOperands& operands);
  static s32 FastMeleeInputPollNoChangeCallBranch(PowerPC::PowerPCState& ppc_state,
                                                  const FastInstructionOperands& operands);
  static s32 FastMeleeInputPollNoChangeCallBranch(std::ostream& stream,
                                                  const FastInstructionOperands& operands);
  static s32 FastDcbx(PowerPC::PowerPCState& ppc_state,
                      const FastInstructionOperands& operands);
  static s32 FastDcbx(std::ostream& stream, const FastInstructionOperands& operands);
  static s32 FastDcbxLoop(PowerPC::PowerPCState& ppc_state,
                          const DcbxLoopOperands& operands);
  static s32 FastDcbxLoop(std::ostream& stream, const DcbxLoopOperands& operands);
  static s32 HLEFunction(PowerPC::PowerPCState& ppc_state, const HLEFunctionOperands& operands);
  static s32 HLEFunction(std::ostream& stream, const HLEFunctionOperands& operands);
  static s32 WriteBrokenBlockNPC(PowerPC::PowerPCState& ppc_state,
                                 const WriteBrokenBlockNPCOperands& operands);
  static s32 WriteBrokenBlockNPC(std::ostream& stream, const WriteBrokenBlockNPCOperands& operands);
  static s32 CheckFPU(PowerPC::PowerPCState& ppc_state, const CheckHaltOperands& operands);
  static s32 CheckFPU(std::ostream& stream, const CheckHaltOperands& operands);
  static s32 CheckBreakpoint(PowerPC::PowerPCState& ppc_state, const CheckHaltOperands& operands);
  static s32 CheckBreakpoint(std::ostream& stream, const CheckHaltOperands& operands);
  static s32 CheckIdle(PowerPC::PowerPCState& ppc_state, const CheckIdleOperands& operands);
  static s32 CheckIdle(std::ostream& stream, const CheckIdleOperands& operands);
#ifdef __EMSCRIPTEN__
  static s32 RunWasmBlock(PowerPC::PowerPCState& ppc_state, const WasmBlockOperands& operands);
  static s32 RunWasmBlock(std::ostream& stream, const WasmBlockOperands& operands);
#endif

  Common::RangeSizeSet<u8*> m_free_ranges;
  CachedInterpreterBlockCache m_block_cache;
};

struct CachedInterpreter::StartProfiledBlockOperands
{
  JitBlock::ProfileData* profile_data;
};

template <>
struct CachedInterpreter::EndBlockOperands<false>
{
  u32 downcount;
  u32 num_load_stores;
  u32 num_fp_inst;
  u32 : 32;
#if DOLPHIN_WEB_STATIC_EXIT_LINKS
  StaticExitLinks::Descriptor links{};
#endif
#line 224
};

template <>
struct CachedInterpreter::EndBlockOperands<true> : CachedInterpreter::EndBlockOperands<false>
{
  JitBlock::ProfileData* profile_data;
};

struct CachedInterpreter::InterpretOperands
{
  Interpreter& interpreter;
  void (*func)(Interpreter&, UGeckoInstruction);  // Interpreter::Instruction
  u32 current_pc;
  UGeckoInstruction inst;
};

struct CachedInterpreter::InterpretAndCheckExceptionsOperands : InterpretOperands
{
  PowerPC::PowerPCManager& power_pc;
  u32 downcount;
};

struct CachedInterpreter::FastInstructionOperands
{
  PowerPC::PowerPCManager& power_pc;
  u32 current_pc;
  UGeckoInstruction inst;
};

struct CachedInterpreter::FastBranchBdnzOperands
{
  PowerPC::PowerPCManager& power_pc;
  u32 current_pc;
  u32 target_pc;
};

struct CachedInterpreter::MeleeIdlePollLoopOperands
{
  PowerPC::PowerPCManager& power_pc;
  u32 current_pc;
  u32 next_pc;
  u32 instruction_cycles_per_iteration;
  u32 instruction_loadstores_per_iteration;
#if DOLPHIN_WEB_STATIC_EXIT_LINKS
  StaticExitLinks::Descriptor links{};
#endif
#line 267
};

struct CachedInterpreter::MeleeTitleLoopOperands
{
  PowerPC::PowerPCManager& power_pc;
  u32 current_pc;
  u32 next_pc;
  u32 cycle_count_per_iteration;
  u32 loadstores_per_iteration;
  u32 fp_inst_per_iteration;
#if DOLPHIN_WEB_STATIC_EXIT_LINKS
  StaticExitLinks::Descriptor links{};
#endif
#line 277
};

struct CachedInterpreter::OsInterruptFunctionOperands
{
  PowerPC::PowerPCManager& power_pc;
  u32 current_pc;
  u32 mode;
  u32 cycles_primary;
  u32 cycles_secondary;
};

struct CachedInterpreter::DcbxLoopOperands
{
  PowerPC::PowerPCManager& power_pc;
  u32 current_pc;
  UGeckoInstruction inst;
  u32 cycle_count_per_loop;
  u32 count_gpr;
  u32 loop_mode;
};

struct CachedInterpreter::HLEFunctionOperands
{
  Core::System& system;
  u32 current_pc;
  u32 hook_index;
};

struct CachedInterpreter::WriteBrokenBlockNPCOperands
{
  u32 current_pc;
  u32 : 32;
};

struct CachedInterpreter::CheckHaltOperands
{
  PowerPC::PowerPCManager& power_pc;
  u32 current_pc;
  u32 downcount;
};

struct CachedInterpreter::CheckIdleOperands
{
  CoreTiming::CoreTimingManager& core_timing;
  u32 idle_pc;
};

#ifdef __EMSCRIPTEN__
struct CachedInterpreter::WasmBlockOperands
{
  s32 handle;
  u32 next_pc;
  u32 downcount;
  u32 num_load_stores;
  u32 num_fp_inst;
  s32 end_block;
#if DOLPHIN_WEB_STATIC_EXIT_LINKS
  StaticExitLinks::Descriptor links{};
#endif
#line 333
  // SNES Touch: runs so far, until the block is hot enough for a wasm region.
  mutable u32 runs = 0;
};
#endif
