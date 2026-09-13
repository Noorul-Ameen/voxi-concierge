import { describe, expect, it, vi } from "vitest";
import { applyVerifiedHumanMode } from "../src/lib/human-mode";

const currentState = () => ({ conversation: { id: "rahul-conversation" }, transfer: { id: "rahul-transfer", status: "connected", agentName: "Current agent" } });
const human = { mode: "human" as const, transferId: "rahul-transfer" };
const neverEnded = () => false;
describe("account-bound handover mode", () => {
  it("uses only a matching current server handover and its agent name", async () => {
    const apply = vi.fn();
    expect(await applyVerifiedHumanMode(human, "rahul-conversation", async () => currentState(), apply, () => true, neverEnded)).toEqual({ ok: true });
    expect(apply).toHaveBeenCalledWith({ transferId: "rahul-transfer", status: "connected", agentName: "Current agent" });
  });
  it("rejects a delayed previous-account client call even when it starts after the new login", async () => {
    const apply = vi.fn();
    expect(await applyVerifiedHumanMode({ mode: "human", transferId: "james-transfer" }, "rahul-conversation", async () => currentState(), apply, () => true, neverEnded)).toMatchObject({ ok: false });
    expect(apply).not.toHaveBeenCalled();
  });
  it.each(["account changed", "token rotated", "new transfer event", "sign-out started"])("discards an in-flight lookup after %s", async () => {
    let current = true;
    let resolve!: (state: ReturnType<typeof currentState>) => void;
    const apply = vi.fn();
    const result = applyVerifiedHumanMode(human, "rahul-conversation", () => new Promise((done) => { resolve = done; }), apply, () => current, neverEnded);
    current = false;
    resolve(currentState());
    expect(await result).toMatchObject({ ok: false });
    expect(apply).not.toHaveBeenCalled();
  });
  it("does not query or apply while authentication is changing", async () => {
    const load = vi.fn(); const apply = vi.fn();
    expect(await applyVerifiedHumanMode(human, "rahul-conversation", load, apply, () => false, neverEnded)).toMatchObject({ ok: false });
    expect(load).not.toHaveBeenCalled(); expect(apply).not.toHaveBeenCalled();
  });
  it.each([
    { conversation: { id: "james-conversation" }, transfer: currentState().transfer },
    { conversation: { id: "rahul-conversation" } },
    { ...currentState(), transfer: { ...currentState().transfer, status: "ended" } },
  ])("never restores a missing, ended or foreign handover: %#", async (state) => {
    const apply = vi.fn();
    expect(await applyVerifiedHumanMode(human, "rahul-conversation", async () => state, apply, () => true, neverEnded)).toMatchObject({ ok: false });
    expect(apply).not.toHaveBeenCalled();
  });
  it("an ended ID cannot be reintroduced by a stale response", async () => {
    let ended = false;
    const apply = vi.fn();
    expect(await applyVerifiedHumanMode(human, "rahul-conversation", async () => { ended = true; return currentState(); }, apply, () => true, () => ended)).toMatchObject({ ok: false });
    expect(apply).not.toHaveBeenCalled();
  });
  it("a delayed bot callback cannot clear the new account's active human chat", async () => {
    const apply = vi.fn();
    expect(await applyVerifiedHumanMode({ mode: "bot" }, "rahul-conversation", async () => currentState(), apply, () => true, neverEnded)).toMatchObject({ ok: false });
    expect(apply).not.toHaveBeenCalled();
  });
  it("permits bot mode only after the current server reports no active transfer", async () => {
    const apply = vi.fn();
    expect(await applyVerifiedHumanMode({ mode: "bot" }, "rahul-conversation", async () => ({ conversation: { id: "rahul-conversation" } }), apply, () => true, neverEnded)).toEqual({ ok: true });
    expect(apply).toHaveBeenCalledWith(null);
  });
  it("does not change UI on a failed verification", async () => {
    const apply = vi.fn();
    expect(await applyVerifiedHumanMode(human, "rahul-conversation", async () => { throw new Error("offline"); }, apply, () => true, neverEnded)).toMatchObject({ ok: false });
    expect(apply).not.toHaveBeenCalled();
  });
});
