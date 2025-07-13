export function PageContainer({ children }: { children: React.ReactNode }) {
	return (
		<div className="flex flex-col items-center min-h-screen bg-background">
			<div className="w-full max-w-md p-2 sm:p-6 ">{children}</div>
		</div>
	);
}
