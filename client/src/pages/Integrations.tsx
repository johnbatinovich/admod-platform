import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Link2, Plus, Trash2, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export default function Integrations() {
  const utils = trpc.useUtils();
  const { data: integrations, isLoading } = trpc.integrations.list.useQuery();
  const [showCreate, setShowCreate] = useState(false);

  const deleteIntegration = trpc.integrations.delete.useMutation({
    onSuccess: () => { utils.integrations.list.invalidate(); toast.success("Integration removed"); },
  });

  const toggleIntegration = trpc.integrations.update.useMutation({
    onSuccess: () => utils.integrations.list.invalidate(),
  });

  const typeColors: Record<string, string> = {
    ad_platform: "bg-blue-500/15 text-blue-400",
    cms: "bg-green-500/15 text-green-400",
    analytics: "bg-purple-500/15 text-purple-400",
    webhook: "bg-orange-500/15 text-orange-400",
    custom: "bg-muted text-muted-foreground",
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Integrations</h1>
          <p className="text-sm text-muted-foreground mt-1">Connect with external ad platforms and media management systems.</p>
        </div>
        <Dialog open={showCreate} onOpenChange={setShowCreate}>
          <DialogTrigger asChild>
            <Button size="sm"><Plus className="h-4 w-4 mr-1.5" />Add Integration</Button>
          </DialogTrigger>
          <DialogContent className="bg-card">
            <DialogHeader><DialogTitle>Add Integration</DialogTitle></DialogHeader>
            <CreateIntegrationForm onSuccess={() => { setShowCreate(false); utils.integrations.list.invalidate(); }} />
          </DialogContent>
        </Dialog>
      </div>

      <Card className="bg-card border-border">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-3">{[1, 2].map(i => <Skeleton key={i} className="h-16 w-full" />)}</div>
          ) : integrations && integrations.length > 0 ? (
            <div className="divide-y divide-border/50">
              {integrations.map(int => {
                const config = int.config as any;
                return (
                  <div key={int.id} className="p-4 hover:bg-accent/30 transition-colors">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center">
                          <Link2 className="h-4 w-4 text-primary" />
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <h3 className="text-sm font-semibold">{int.name}</h3>
                            <Badge variant="outline" className={`text-[10px] ${typeColors[int.type]}`}>
                              {int.type.replace("_", " ")}
                            </Badge>
                          </div>
                          <p className="text-[11px] text-muted-foreground">
                            {config?.endpoint || config?.url || "No endpoint configured"}
                            {int.lastSyncAt && ` · Last sync: ${new Date(int.lastSyncAt).toLocaleString()}`}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={int.isActive ?? true}
                          onCheckedChange={(checked) => toggleIntegration.mutate({ id: int.id, isActive: checked })}
                        />
                        <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-destructive" onClick={() => deleteIntegration.mutate({ id: int.id })}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-center py-12">
              <Link2 className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">No integrations configured. Add one to connect with external platforms.</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function CreateIntegrationForm({ onSuccess }: { onSuccess: () => void }) {
  const [form, setForm] = useState({ name: "", type: "webhook" as any, endpoint: "", apiKey: "", description: "" });
  const create = trpc.integrations.create.useMutation({
    onSuccess: () => { toast.success("Integration added"); onSuccess(); },
    onError: (e) => toast.error(e.message),
  });
  return (
    <div className="space-y-3">
      <div className="space-y-1"><Label className="text-sm">Name *</Label><Input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} className="bg-background" placeholder="Integration name..." /></div>
      <div className="space-y-1">
        <Label className="text-sm">Type</Label>
        <Select value={form.type} onValueChange={v => setForm(p => ({ ...p, type: v }))}>
          <SelectTrigger className="bg-background"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ad_platform">Ad Platform</SelectItem>
            <SelectItem value="cms">CMS</SelectItem>
            <SelectItem value="analytics">Analytics</SelectItem>
            <SelectItem value="webhook">Webhook</SelectItem>
            <SelectItem value="custom">Custom</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1"><Label className="text-sm">Endpoint URL</Label><Input value={form.endpoint} onChange={e => setForm(p => ({ ...p, endpoint: e.target.value }))} className="bg-background" placeholder="https://..." /></div>
      <div className="space-y-1"><Label className="text-sm">API Key</Label><Input type="password" value={form.apiKey} onChange={e => setForm(p => ({ ...p, apiKey: e.target.value }))} className="bg-background" placeholder="Optional API key..." /></div>
      <Button onClick={() => {
        if (!form.name.trim()) { toast.error("Name required"); return; }
        create.mutate({ name: form.name, type: form.type, config: { endpoint: form.endpoint, apiKey: form.apiKey } });
      }} disabled={create.isPending} className="w-full">
        {create.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}Add Integration
      </Button>
    </div>
  );
}
