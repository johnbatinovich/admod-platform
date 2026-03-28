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
import { Shield, Plus, Download, Trash2, Edit, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export default function Policies() {
  const utils = trpc.useUtils();
  const { data: policies, isLoading } = trpc.policies.list.useQuery({});
  const [showCreate, setShowCreate] = useState(false);

  const seedTemplates = trpc.policies.seedTemplates.useMutation({
    onSuccess: (data) => {
      utils.policies.list.invalidate();
      toast.success(`${data.count} compliance templates loaded`);
    },
    onError: (e) => toast.error(e.message),
  });

  const deletePolicy = trpc.policies.delete.useMutation({
    onSuccess: () => { utils.policies.list.invalidate(); toast.success("Policy deleted"); },
  });

  const togglePolicy = trpc.policies.update.useMutation({
    onSuccess: () => { utils.policies.list.invalidate(); },
  });

  const severityColors: Record<string, string> = {
    info: "bg-blue-500/15 text-blue-400",
    warning: "bg-yellow-500/15 text-yellow-400",
    critical: "bg-orange-500/15 text-orange-400",
    blocking: "bg-red-500/15 text-red-400",
  };

  const categoryLabels: Record<string, string> = {
    content_standards: "Content Standards",
    brand_safety: "Brand Safety",
    legal_compliance: "Legal Compliance",
    industry_specific: "Industry Specific",
    platform_rules: "Platform Rules",
    custom: "Custom",
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Policies</h1>
          <p className="text-sm text-muted-foreground mt-1">Configure moderation policies and compliance rules.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => seedTemplates.mutate()} disabled={seedTemplates.isPending}>
            {seedTemplates.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <Shield className="h-4 w-4 mr-1.5" />}
            Seed FCC/IAB Templates
          </Button>
          <Dialog open={showCreate} onOpenChange={setShowCreate}>
            <DialogTrigger asChild>
              <Button size="sm"><Plus className="h-4 w-4 mr-1.5" />New Policy</Button>
            </DialogTrigger>
            <DialogContent className="bg-card">
              <DialogHeader>
                <DialogTitle>Create Policy</DialogTitle>
              </DialogHeader>
              <CreatePolicyForm onSuccess={() => { setShowCreate(false); utils.policies.list.invalidate(); }} />
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <Card className="bg-card border-border">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-3">
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-16 w-full" />)}
            </div>
          ) : policies && policies.length > 0 ? (
            <div className="divide-y divide-border/50">
              {policies.map(policy => {
                const rules = policy.rules as any;
                return (
                  <div key={policy.id} className="p-4 hover:bg-accent/30 transition-colors">
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <h3 className="text-sm font-semibold">{policy.name}</h3>
                          {policy.isTemplate && <Badge variant="outline" className="text-[10px]">Template</Badge>}
                          <Badge variant="outline" className={`text-[10px] ${severityColors[policy.severity]}`}>{policy.severity}</Badge>
                          <Badge variant="outline" className="text-[10px]">{categoryLabels[policy.category] || policy.category}</Badge>
                          {policy.complianceFramework && (
                            <Badge variant="outline" className="text-[10px] bg-primary/10 text-primary">{policy.complianceFramework}</Badge>
                          )}
                        </div>
                        {policy.description && <p className="text-xs text-muted-foreground mb-2">{policy.description}</p>}
                        {rules?.checks && (
                          <div className="flex flex-wrap gap-1">
                            {(rules.checks as string[]).slice(0, 4).map((check, i) => (
                              <span key={i} className="text-[10px] px-2 py-0.5 rounded bg-muted text-muted-foreground">{check}</span>
                            ))}
                            {rules.checks.length > 4 && (
                              <span className="text-[10px] px-2 py-0.5 rounded bg-muted text-muted-foreground">+{rules.checks.length - 4} more</span>
                            )}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-2 ml-3">
                        <Switch
                          checked={policy.isActive}
                          onCheckedChange={(checked) => togglePolicy.mutate({ id: policy.id, isActive: checked })}
                        />
                        <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-destructive" onClick={() => deletePolicy.mutate({ id: policy.id })}>
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
              <Shield className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">No policies configured. Load templates or create a custom policy.</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function CreatePolicyForm({ onSuccess }: { onSuccess: () => void }) {
  const [form, setForm] = useState({
    name: "",
    description: "",
    category: "custom" as any,
    severity: "warning" as any,
    complianceFramework: "",
    rulesText: "",
  });

  const createPolicy = trpc.policies.create.useMutation({
    onSuccess: () => { toast.success("Policy created"); onSuccess(); },
    onError: (e) => toast.error(e.message),
  });

  const handleSubmit = () => {
    if (!form.name.trim()) { toast.error("Name is required"); return; }
    const rules = form.rulesText.trim()
      ? { checks: form.rulesText.split("\n").filter(Boolean) }
      : undefined;
    createPolicy.mutate({
      name: form.name,
      description: form.description || undefined,
      category: form.category,
      severity: form.severity,
      complianceFramework: form.complianceFramework || undefined,
      rules,
    });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label className="text-sm">Name *</Label>
        <Input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} className="bg-background" placeholder="Policy name..." />
      </div>
      <div className="space-y-2">
        <Label className="text-sm">Description</Label>
        <Textarea value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} className="bg-background" placeholder="Describe the policy..." />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label className="text-sm">Category</Label>
          <Select value={form.category} onValueChange={v => setForm(p => ({ ...p, category: v }))}>
            <SelectTrigger className="bg-background"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="content_standards">Content Standards</SelectItem>
              <SelectItem value="brand_safety">Brand Safety</SelectItem>
              <SelectItem value="legal_compliance">Legal Compliance</SelectItem>
              <SelectItem value="industry_specific">Industry Specific</SelectItem>
              <SelectItem value="platform_rules">Platform Rules</SelectItem>
              <SelectItem value="custom">Custom</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label className="text-sm">Severity</Label>
          <Select value={form.severity} onValueChange={v => setForm(p => ({ ...p, severity: v }))}>
            <SelectTrigger className="bg-background"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="info">Info</SelectItem>
              <SelectItem value="warning">Warning</SelectItem>
              <SelectItem value="critical">Critical</SelectItem>
              <SelectItem value="blocking">Blocking</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="space-y-2">
        <Label className="text-sm">Compliance Framework</Label>
        <Input value={form.complianceFramework} onChange={e => setForm(p => ({ ...p, complianceFramework: e.target.value }))} className="bg-background" placeholder="e.g., FCC, FTC, GDPR..." />
      </div>
      <div className="space-y-2">
        <Label className="text-sm">Rules (one per line)</Label>
        <Textarea value={form.rulesText} onChange={e => setForm(p => ({ ...p, rulesText: e.target.value }))} className="bg-background min-h-[100px]" placeholder="Enter each rule on a new line..." />
      </div>
      <Button onClick={handleSubmit} disabled={createPolicy.isPending} className="w-full">
        {createPolicy.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
        Create Policy
      </Button>
    </div>
  );
}
