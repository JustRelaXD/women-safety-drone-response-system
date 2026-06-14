import cloudinary
import cloudinary.uploader
import io

cloudinary.config(
    cloud_name="dqtjhawtb",
    api_key="548639571694591",
    api_secret="3uANUz_kK7sIDN1g9ReRNx-Vkro",
    secure=True
)

def upload_file(file_bytes, filename, folder):
    name = "evidence-" + folder.replace("/", "-") + "-" + filename[:20]
    buf = io.BytesIO(file_bytes)
    result = cloudinary.uploader.upload(buf, resource_type="auto", public_id=name)
    return result["secure_url"]