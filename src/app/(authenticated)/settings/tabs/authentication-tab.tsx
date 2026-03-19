"use client";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Loader2,
  CheckCircle,
  XCircle,
  Save,
  Lock,
  AlertCircle,
} from "lucide-react";
import type { AuthInfo } from "../types";

export interface CredentialsForm {
  currentPassword: string;
  newUsername: string;
  newPassword: string;
  confirmPassword: string;
}

export interface PromptForm {
  username: string;
  password: string;
  confirmPassword: string;
}

export interface AuthenticationTabProps {
  authInfo: AuthInfo | null;
  authLoading: boolean;
  plexLinking: boolean;
  credentialsForm: CredentialsForm;
  credentialsSaving: boolean;
  credentialsError: string;
  credentialsSuccess: string;
  showCredentialPrompt: boolean;
  promptForm: PromptForm;
  promptError: string;
  promptSaving: boolean;
  onSetCredentialsForm: (updater: (prev: CredentialsForm) => CredentialsForm) => void;
  onSetPromptForm: (updater: (prev: PromptForm) => PromptForm) => void;
  onSetShowCredentialPrompt: (open: boolean) => void;
  onToggleLocalAuth: (enabled: boolean) => void;
  onChangeCredentials: () => void;
  onPlexLink: () => void;
  onCreateCredentialsAndEnable: () => void;
}

export function AuthenticationTab({
  authInfo,
  authLoading,
  plexLinking,
  credentialsForm,
  credentialsSaving,
  credentialsError,
  credentialsSuccess,
  showCredentialPrompt,
  promptForm,
  promptError,
  promptSaving,
  onSetCredentialsForm,
  onSetPromptForm,
  onSetShowCredentialPrompt,
  onToggleLocalAuth,
  onChangeCredentials,
  onPlexLink,
  onCreateCredentialsAndEnable,
}: AuthenticationTabProps) {
  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold">Authentication</h2>

      {/* Plex Connection */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            Plex Connection
          </CardTitle>
          <CardDescription>
            Link your Plex account for server discovery and Plex OAuth login
          </CardDescription>
        </CardHeader>
        <CardContent>
          {authInfo?.plexConnected ? (
            <div className="flex items-center gap-2 text-sm">
              <CheckCircle className="h-4 w-4 text-green-500" />
              <span>Connected as <strong>{authInfo.displayName}</strong></span>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <XCircle className="h-4 w-4" />
                <span>No Plex account connected</span>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={plexLinking}
                onClick={onPlexLink}
              >
                {plexLinking ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                {plexLinking ? "Waiting for Plex..." : "Connect Plex Account"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Local Authentication */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            Local Authentication
          </CardTitle>
          <CardDescription>
            Enable username/password login in addition to Plex
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Enable Local Login</p>
              <p className="text-xs text-muted-foreground">
                Allow signing in with username and password
              </p>
            </div>
            <Switch
              checked={authInfo?.localAuthEnabled ?? false}
              disabled={authLoading || (!authInfo?.plexConnected && !authInfo?.localAuthEnabled)}
              onCheckedChange={onToggleLocalAuth}
            />
          </div>
          {!authInfo?.plexConnected && !authInfo?.localAuthEnabled && (
            <div className="flex items-center gap-2 rounded-md bg-muted p-3 text-sm text-muted-foreground">
              <AlertCircle className="h-4 w-4 shrink-0" />
              Connect a Plex account before disabling local auth to avoid losing access
            </div>
          )}
          {authInfo?.hasPassword && (
            <>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <CheckCircle className="h-4 w-4 text-green-500" />
                Local username: <strong>{authInfo.localUsername}</strong>
              </div>

              <div className="border-t pt-4 space-y-3">
                <h4 className="text-sm font-medium">Change Credentials</h4>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label htmlFor="cred-username">New Username</Label>
                    <Input
                      id="cred-username"
                      placeholder={authInfo.localUsername ?? "username"}
                      value={credentialsForm.newUsername}
                      onChange={(e) => onSetCredentialsForm((f) => ({ ...f, newUsername: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="cred-current-pw">Current Password</Label>
                    <Input
                      id="cred-current-pw"
                      type="password"
                      placeholder="Required to make changes"
                      value={credentialsForm.currentPassword}
                      onChange={(e) => onSetCredentialsForm((f) => ({ ...f, currentPassword: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="cred-new-pw">New Password</Label>
                    <Input
                      id="cred-new-pw"
                      type="password"
                      placeholder="Min 8 characters"
                      value={credentialsForm.newPassword}
                      onChange={(e) => onSetCredentialsForm((f) => ({ ...f, newPassword: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="cred-confirm-pw">Confirm New Password</Label>
                    <Input
                      id="cred-confirm-pw"
                      type="password"
                      placeholder="Repeat new password"
                      value={credentialsForm.confirmPassword}
                      onChange={(e) => onSetCredentialsForm((f) => ({ ...f, confirmPassword: e.target.value }))}
                    />
                  </div>
                </div>
                {credentialsError && (
                  <div className="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    {credentialsError}
                  </div>
                )}
                {credentialsSuccess && (
                  <div className="flex items-center gap-2 rounded-md bg-green-500/10 p-3 text-sm text-green-500">
                    <CheckCircle className="h-4 w-4 shrink-0" />
                    {credentialsSuccess}
                  </div>
                )}
                <Button
                  size="sm"
                  disabled={credentialsSaving || !credentialsForm.currentPassword || (!credentialsForm.newUsername && !credentialsForm.newPassword)}
                  onClick={onChangeCredentials}
                >
                  {credentialsSaving ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="mr-2 h-4 w-4" />
                  )}
                  Save Changes
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Create Credentials Dialog -- shown when enabling local auth without existing credentials */}
      <Dialog open={showCredentialPrompt} onOpenChange={(open) => { if (!open) onSetShowCredentialPrompt(false); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create Local Login Credentials</DialogTitle>
            <DialogDescription>
              Set a username and password to enable local authentication.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="prompt-username">Username</Label>
              <Input
                id="prompt-username"
                placeholder="Min 3 characters"
                value={promptForm.username}
                onChange={(e) => onSetPromptForm((f) => ({ ...f, username: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="prompt-password">Password</Label>
              <Input
                id="prompt-password"
                type="password"
                placeholder="Min 8 characters"
                value={promptForm.password}
                onChange={(e) => onSetPromptForm((f) => ({ ...f, password: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="prompt-confirm">Confirm Password</Label>
              <Input
                id="prompt-confirm"
                type="password"
                placeholder="Repeat password"
                value={promptForm.confirmPassword}
                onChange={(e) => onSetPromptForm((f) => ({ ...f, confirmPassword: e.target.value }))}
              />
            </div>
            {promptError && (
              <div className="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                <AlertCircle className="h-4 w-4 shrink-0" />
                {promptError}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => onSetShowCredentialPrompt(false)}>
              Cancel
            </Button>
            <Button
              disabled={promptSaving || !promptForm.username || !promptForm.password || !promptForm.confirmPassword}
              onClick={onCreateCredentialsAndEnable}
            >
              {promptSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Lock className="mr-2 h-4 w-4" />}
              Create & Enable
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
