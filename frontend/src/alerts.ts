import Swal from "sweetalert2";

type ConfirmOptions = {
  title: string;
  text?: string;
  confirmButtonText?: string;
  cancelButtonText?: string;
};

export async function confirmAction({
  title,
  text,
  confirmButtonText = "Confirm",
  cancelButtonText = "Cancel"
}: ConfirmOptions) {
  const result = await Swal.fire({
    title,
    text,
    icon: "warning",
    showCancelButton: true,
    confirmButtonText,
    cancelButtonText,
    reverseButtons: true,
    focusCancel: true
  });

  return result.isConfirmed;
}

export function showNotice(message?: string) {
  return Swal.fire({
    icon: "info",
    title: "Notice",
    text: String(message ?? ""),
    confirmButtonText: "OK"
  });
}
