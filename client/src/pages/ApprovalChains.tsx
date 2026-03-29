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
import { ScrollText, Plus, Trash2, Loader2, ArrowRight } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export default function ApprovalChains() {
  const utils = trpc.useUtils();
  const { data: chains, isLoading } = trpc.approvalChains.list.useQuery();
  const [showCreate, setShowCreate] = useState(false);

  const updateChain = trpc.approvalChains.update.useMutation({
    onSuccess: () => utils.approvalChains.list.invalidate(),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Approval Chains</h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Define the review stages an ad must pass through before airing. Ads flagged by the AI agent for human review are automatically routed through the default chain. Each stage requires sign-off from the designated role before advancing.
          </p>
        </div>
        <Dialog open={showCreate} onOpenChange={setShowCreate}>
          <DialogTrigger asChild>
            <Button size="sm"><Plus className="h-4 w-4 mr-1.5" />New Chain</Button>
          </DialogTrigger>
          <DialogContent className="bg-card max-w-lg">
            <DialogHeader>
              <DialogTitle>Create Approval Chain</DialogTitle>
            </DialogHeader>
            <CreateChainForm onSuccess={() => { setShowCreate(false); utils.approvalChains.list.invalidate(); }} />
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2].map(i => <Skeleton key={i} className="h-32 w-full" />)}
        </div>
      ) : chains && chains.length > 0 ? (
        <div className="space-y-3">
          {chains.map(chain => {
            const steps = (chain.steps as any[]) || [];
            return (
              <Card key={chain.id} className="bg-card border-border">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-semibold">{chain.name}</h3>
                        {chain.isDefault && <Badge className="text-[10px]">Default</Badge>}
                        <Badge variant={chain.isActive ? "default" : "secondary"} className="text-[10px]">
                          {chain.isActive ? "Active" : "Inactive"}
                        </Badge>
                      </div>
                      {chain.description && <p className="text-xs text-muted-foreground mt-1">{chain.description}</p>}
                    </div>
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={chain.isActive ?? true}
                        onCheckedChange={(checked) => updateChain.mutate({ id: chain.id, isActive: checked })}
                      />
                    </div>
                  </div>
                  {steps.length > 0 && (
                    <div className="flex items-center gap-2 flex-wrap">
                      {steps.map((step: any, i: number) => (
                        <div key={i} className="flex items-center gap-2">
                          <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-background border border-border/50">
                            <span className="text-[10px] font-bold text-primary">{step.step}</span>
                            <span className="text-xs">{step.name}</span>
                            <Badge variant="outline" className="text-[9px]">{step.role}</Badge>
                          </div>
                          {i < steps.length - 1 && <ArrowRight className="h-3 w-3 text-muted-foreground" />}
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : (
        <div className="space-y-3">
          <Card className="bg-primary/5 border-primary/20">
            <CardContent className="p-4">
              <p className="text-sm leading-relaxed">
                When the AI agent reviews an ad and recommends human review, it assigns the ad to your default approval chain.
                Each step in the chain must be approved before the ad is cleared for broadcast.{" "}
                <span className="font-semibold text-destructive">Rejected at any step = ad rejected.</span>
              </p>
            </CardContent>
          </Card>
          <Card className="bg-card border-border">
            <CardContent className="text-center py-12">
              <ScrollText className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">No approval chains configured. Create one to enable multi-step review.</p>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

function CreateChainForm({ onSuccess }: { onSuccess: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [steps, setSteps] = useState([{ step: 1, name: "Initial Review", role: "reviewer" }]);

  const createChain = trpc.approvalChains.create.useMutation({
    onSuccess: () => { toast.success("Approval chain created"); onSuccess(); },
    onError: (e) => toast.error(e.message),
  });

  const addStep = () => {
    setSteps(prev => [...prev, { step: prev.length + 1, name: "", role: "reviewer" }]);
  };

  const removeStep = (index: number) => {
    setSteps(prev => prev.filter((_, i) => i !== index).map((s, i) => ({ ...s, step: i + 1 })));
  };

  const updateStep = (index: number, field: string, value: string) => {
    setSteps(prev => prev.map((s, i) => i === index ? { ...s, [field]: value } : s));
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label className="text-sm">Name *</Label>
        <Input value={name} onChange={e => setName(e.target.value)} className="bg-background" placeholder="Chain name..." />
      </div>
      <div className="space-y-2">
        <Label className="text-sm">Description</Label>
        <Textarea value={description} onChange={e => setDescription(e.target.value)} className="bg-background" placeholder="Describe the workflow..." />
      </div>
      <div className="flex items-center gap-2">
        <Switch checked={isDefault} onCheckedChange={setIsDefault} />
        <Label className="text-sm">Set as default chain</Label>
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-sm">Steps</Label>
          <Button variant="ghost" size="sm" onClick={addStep} className="h-7 text-xs"><Plus className="h-3 w-3 mr-1" />Add Step</Button>
        </div>
        {steps.map((step, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="text-xs font-bold text-primary w-6">{step.step}</span>
            <Input
              value={step.name}
              onChange={e => updateStep(i, "name", e.target.value)}
              className="bg-background flex-1"
              placeholder="Step name..."
            />
            <Select value={step.role} onValueChange={v => updateStep(i, "role", v)}>
              <SelectTrigger className="bg-background w-[130px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="reviewer">Reviewer</SelectItem>
                <SelectItem value="moderator">Moderator</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
              </SelectContent>
            </Select>
            {steps.length > 1 && (
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-destructive" onClick={() => removeStep(i)}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        ))}
      </div>
      <Button
        onClick={() => {
          if (!name.trim()) { toast.error("Name is required"); return; }
          createChain.mutate({ name, description: description || undefined, steps, isDefault });
        }}
        disabled={createChain.isPending}
        className="w-full"
      >
        {createChain.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
        Create Chain
      </Button>
    </div>
  );
}
