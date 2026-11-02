"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { fetchWithReauth } from "@/lib/auth/reauth-client";
import { responseErrorMessage } from "@/lib/api/error-message";
import type { TestResult } from "./types";
import {
  EMPTY_INSTANCE_FORM,
  addRequestBody,
  editFormOf,
  editRequestBody,
  testConnectionBody,
  type IntegrationBehavior,
  type IntegrationInstance,
  type InstanceForm,
} from "./integration-instances";

export interface UseIntegrationInstancesOptions<I extends IntegrationInstance> {
  /** The type's instances, as the page last read them. */
  instances: I[];
  /** Re-read the type's instance list (after an add, edit, removal or toggle). */
  refresh: () => Promise<unknown>;
  /** After an edit is saved: Tracearr re-reads that instance's server list. */
  onUpdated?: (id: string) => unknown;
}

/** The add form above the list. */
export interface IntegrationAddForm {
  open: boolean;
  form: InstanceForm;
  saving: boolean;
  error: string;
  testing: boolean;
  testResult: TestResult | null;
  setOpen: (open: boolean) => void;
  setForm: (form: InstanceForm) => void;
  submit: () => Promise<void>;
  /** Test the URL and key on screen (`POST /api/integrations/<type>/test`). */
  test: () => Promise<void>;
}

/** The inline edit form of one saved instance. */
export interface IntegrationEditForm<I extends IntegrationInstance> {
  /** The instance being edited, or null. */
  id: string | null;
  form: InstanceForm;
  saving: boolean;
  error: string;
  testing: boolean;
  testResult: TestResult | null;
  /** Open the form and test the stored connection at once. */
  start: (instance: I) => void;
  setForm: (form: InstanceForm) => void;
  save: () => Promise<void>;
  /** Test what is on screen, falling back to the stored URL and key. */
  test: () => Promise<void>;
  cancel: () => void;
}

export interface IntegrationInstancesState<I extends IntegrationInstance> {
  instances: I[];
  add: IntegrationAddForm;
  edit: IntegrationEditForm<I>;
  remove: (id: string) => Promise<void>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * One integration type's instances on Settings → Integrations: the add form
 * and its test, the inline edit form and its test, removal and the enable
 * toggle. The page held this for each of the five types by hand — some sixty
 * pieces of state, with the copies drifting (only the Arr and Seerr edit tests
 * guarded against a stale answer).
 *
 * What it keeps, for every type:
 * - the edit save and the edit test go through `fetchWithReauth`, since both
 *   can send the STORED key to a new URL (`refuseStoredKeyToNewUrl`);
 * - the External URL is sent only when it changed (`editRequestBody`);
 * - a refused save shows the first validation detail (`responseErrorMessage`);
 * - a connection test is only ever answered by the newest one, and a change to
 *   the URL or key drops the answer, so Save never acts on a result for
 *   credentials no longer on screen.
 */
export function useIntegrationInstances<I extends IntegrationInstance>(
  behavior: IntegrationBehavior,
  { instances, refresh, onUpdated }: UseIntegrationInstancesOptions<I>,
): IntegrationInstancesState<I> {
  const { type, label, toggleNoun } = behavior;

  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddFormState] = useState<InstanceForm>(EMPTY_INSTANCE_FORM);
  const [addSaving, setAddSaving] = useState(false);
  const [addError, setAddError] = useState("");
  const [addTesting, setAddTesting] = useState(false);
  const [addTestResult, setAddTestResult] = useState<TestResult | null>(null);

  const [editId, setEditId] = useState<string | null>(null);
  const [editForm, setEditFormState] = useState<InstanceForm>(EMPTY_INSTANCE_FORM);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState("");
  const [editTesting, setEditTesting] = useState(false);
  const [editTestResult, setEditTestResult] = useState<TestResult | null>(null);

  // Per-form test sequence: only the newest test may write its result. A test
  // still in flight for another instance (Edit A → Cancel → Edit B) or for
  // credentials since edited used to land afterwards and overwrite the form's
  // result — disabling Save on a healthy instance, or enabling it on one whose
  // new credentials were never tested.
  const addTestSeq = useRef(0);
  const editTestSeq = useRef(0);

  const dropAddTest = () => {
    addTestSeq.current += 1;
    setAddTesting(false);
    setAddTestResult(null);
  };
  const dropEditTest = () => {
    editTestSeq.current += 1;
    setEditTesting(false);
    setEditTestResult(null);
  };

  const testAdd = async () => {
    const seq = ++addTestSeq.current;
    const current = () => addTestSeq.current === seq;
    setAddTesting(true);
    setAddTestResult(null);
    try {
      const response = await fetch(`/api/integrations/${type}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: addForm.url, apiKey: addForm.apiKey }),
      });
      const data = await response.json();
      if (current()) setAddTestResult(data);
    } catch {
      if (current()) setAddTestResult({ ok: false, error: "Request failed" });
    } finally {
      if (current()) setAddTesting(false);
    }
  };

  const submitAdd = async () => {
    setAddSaving(true);
    setAddError("");
    try {
      const response = await fetch(`/api/integrations/${type}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(addRequestBody(addForm, behavior)),
      });
      const data = await response.json();
      if (!response.ok) {
        // For Tracearr, which has no unsaved-instance test, this is the
        // connection test: its detail is what the user has to act on.
        setAddError(responseErrorMessage(data, `Failed to add ${label} instance`));
        return;
      }
      setAddFormState(EMPTY_INSTANCE_FORM);
      dropAddTest();
      setAddOpen(false);
      await refresh();
      toast.success(`${label} instance added`);
    } catch (error) {
      setAddError(`Failed to add ${label} instance`);
      console.error(error);
    } finally {
      setAddSaving(false);
    }
  };

  const testEdit = async (id: string, overrides: { url?: string; apiKey?: string }) => {
    const seq = ++editTestSeq.current;
    const current = () => editTestSeq.current === seq;
    setEditTesting(true);
    setEditTestResult(null);
    try {
      const response = await fetchWithReauth(`/api/integrations/${type}/${id}/test-connection`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(testConnectionBody(overrides)),
      });
      const data = await response.json();
      if (current()) setEditTestResult(data);
    } catch {
      if (current()) setEditTestResult({ ok: false, error: "Request failed" });
    } finally {
      if (current()) setEditTesting(false);
    }
  };

  const startEdit = (instance: I) => {
    setEditId(instance.id);
    setEditFormState(editFormOf(instance));
    setEditError("");
    void testEdit(instance.id, {});
  };

  const saveEdit = async () => {
    if (!editId) return;
    const savedId = editId;
    setEditSaving(true);
    setEditError("");
    try {
      const stored = instances.find((instance) => instance.id === savedId);
      const body = editRequestBody(editForm, stored, behavior);
      const response = await fetchWithReauth(`/api/integrations/${type}/${savedId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) {
        setEditError(responseErrorMessage(data, "Failed to update"));
        return;
      }
      setEditId(null);
      await refresh();
      await onUpdated?.(savedId);
      toast.success(`${label} instance updated`);
    } catch {
      setEditError(`Failed to update ${label} instance`);
    } finally {
      setEditSaving(false);
    }
  };

  const remove = async (id: string) => {
    try {
      const response = await fetch(`/api/integrations/${type}/${id}`, { method: "DELETE" });
      if (!response.ok) {
        toast.error(`Failed to remove ${label} instance`);
        return;
      }
      toast.success(`${label} instance removed`);
      await refresh();
    } catch {
      toast.error(`Failed to remove ${label} instance`);
    }
  };

  const setEnabled = async (id: string, enabled: boolean) => {
    try {
      const response = await fetch(`/api/integrations/${type}/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (response.ok) {
        await refresh();
        toast.success(`${capitalize(toggleNoun)} ${enabled ? "enabled" : "disabled"}`);
      } else {
        toast.error(`Failed to update ${toggleNoun}`);
      }
    } catch (error) {
      console.error(`Failed to toggle ${toggleNoun} enabled:`, error);
      toast.error(`Failed to update ${toggleNoun}`);
    }
  };

  return {
    instances,
    add: {
      open: addOpen,
      form: addForm,
      saving: addSaving,
      error: addError,
      testing: addTesting,
      testResult: addTestResult,
      setOpen: setAddOpen,
      setForm: (form) => {
        if (form.url !== addForm.url || form.apiKey !== addForm.apiKey) dropAddTest();
        setAddFormState(form);
      },
      submit: submitAdd,
      test: testAdd,
    },
    edit: {
      id: editId,
      form: editForm,
      saving: editSaving,
      error: editError,
      testing: editTesting,
      testResult: editTestResult,
      start: startEdit,
      setForm: (form) => {
        if (form.url !== editForm.url || form.apiKey !== editForm.apiKey) dropEditTest();
        setEditFormState(form);
      },
      save: saveEdit,
      test: async () => {
        if (editId) await testEdit(editId, { url: editForm.url, apiKey: editForm.apiKey });
      },
      cancel: () => {
        dropEditTest();
        setEditId(null);
      },
    },
    remove,
    setEnabled,
  };
}
