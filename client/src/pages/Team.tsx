import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Users, Shield } from "lucide-react";
import { toast } from "sonner";

export default function Team() {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const { data: users, isLoading } = trpc.users.list.useQuery();

  const updateRole = trpc.users.updateRole.useMutation({
    onSuccess: () => { utils.users.list.invalidate(); toast.success("Role updated"); },
    onError: (e) => toast.error(e.message),
  });

  const isAdmin = user?.role === "admin";

  const roleColors: Record<string, string> = {
    viewer: "bg-muted text-muted-foreground",
    reviewer: "bg-blue-50 text-blue-600",
    moderator: "bg-purple-50 text-purple-700",
    admin: "bg-primary/15 text-primary",
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Team Management</h1>
        <p className="text-sm text-muted-foreground mt-1">Manage team members and their platform roles.</p>
      </div>

      <Card className="bg-card border-border">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-3">
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-14 w-full" />)}
            </div>
          ) : users && users.length > 0 ? (
            <div className="divide-y divide-border/50">
              {users.map(u => (
                <div key={u.id} className="flex items-center justify-between p-4">
                  <div className="flex items-center gap-3">
                    <Avatar className="h-9 w-9">
                      <AvatarFallback className="text-xs bg-primary/20 text-primary">
                        {u.name?.charAt(0).toUpperCase() || "U"}
                      </AvatarFallback>
                    </Avatar>
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium">{u.name || "Unnamed"}</p>
                        {u.role === "admin" && <Badge variant="outline" className="text-[9px] bg-primary/10 text-primary">Owner</Badge>}
                      </div>
                      <p className="text-[11px] text-muted-foreground">{u.email || "No email"} · Joined {new Date(u.createdAt).toLocaleDateString()}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge variant="outline" className={`text-[10px] ${roleColors[u.platformRole]}`}>
                      {u.platformRole}
                    </Badge>
                    {isAdmin && (
                      <Select
                        value={u.platformRole}
                        onValueChange={(v: any) => updateRole.mutate({ userId: u.id, platformRole: v })}
                      >
                        <SelectTrigger className="w-[120px] h-8 text-xs bg-background">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="viewer">Viewer</SelectItem>
                          <SelectItem value="reviewer">Reviewer</SelectItem>
                          <SelectItem value="moderator">Moderator</SelectItem>
                          <SelectItem value="admin">Admin</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-12">
              <Users className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">No team members yet.</p>
            </div>
          )}
        </CardContent>
      </Card>

      {!isAdmin && (
        <Card className="bg-card border-border">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Shield className="h-4 w-4" />
              <span>Only administrators can modify team roles.</span>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
